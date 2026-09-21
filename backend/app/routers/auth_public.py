"""Rota PÚBLICA do "esqueci minha senha".

Antes o navegador chamava `supabase.auth.resetPasswordForEmail` direto, e o
Supabase mandava o template global do painel — em inglês, para todo mundo.
Agora o pedido passa por aqui: o backend gera o link de recuperação SEM o
Supabase enviar nada e redige o e-mail no idioma da tela de quem pediu
(header X-Language).

Como a porta está aberta para a internet inteira, o que o Supabase fazia por
nós vem junto:

- **Captcha** verificado no servidor (hCaptcha, a mesma site key da tela de
  login). Sem o token válido, nada acontece.
- **Sem enumeração de contas**: a resposta é a mesma exista ou não a conta,
  e o trabalho (gerar link + enviar) roda DEPOIS da resposta, em background,
  para nem o tempo de resposta denunciar quem está cadastrado.
- **Limite de envio** por e-mail (60 s) e por IP, em memória. É rede de
  segurança, não a porta — o backend roda com mais de um worker e cada um
  conta sozinho; o que barra o abuso é o captcha. Quem estoura recebe o mesmo
  200 de sempre, sem e-mail.

Exceções do httpx são tratadas aqui dentro de propósito: se escapassem, o
handler global do main.py as devolveria como "Database connection error".
"""
import logging
import threading
import time
from collections import deque
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import BaseModel, EmailStr, Field

from app.config import get_settings
from app.dependencies import get_language
from app.services.activity_log_service import ActivityLogService
from app.services.auth_link_service import gerar_link
from app.services.email_service import enviar_email, renderizar
from app.utils.erros import erro_http, recusado

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/auth", tags=["public"])

_HCAPTCHA_URL = "https://api.hcaptcha.com/siteverify"

# Recado devolvido em qualquer desfecho que não seja erro de preenchimento ou
# de captcha — inclusive quando a conta não existe ou o envio falhou.
_RECEBIDO = {"received": True}


class ForgotPasswordIn(BaseModel):
    email: EmailStr
    captcha_token: Optional[str] = Field(None, max_length=8192)


class _Limitador:
    """Cooldown por e-mail e janela por IP, por processo.

    Com `gunicorn --workers 2` cada worker tem o seu — o limite efetivo é
    ~2x o configurado. Suficiente como backstop: o captcha é a porta.
    """

    COOLDOWN_EMAIL = 60          # segundos entre dois pedidos para o mesmo e-mail
    JANELA_IP = 15 * 60          # segundos
    MAX_POR_IP = 10              # pedidos por janela
    _MAX_ENTRADAS = 5000         # poda para a memória não crescer sem fim

    def __init__(self):
        self._lock = threading.Lock()
        self._por_email = {}
        self._por_ip = {}

    def permitir(self, email: str, ip: Optional[str], agora: Optional[float] = None) -> bool:
        agora = time.monotonic() if agora is None else agora
        with self._lock:
            self._podar(agora)
            ultimo = self._por_email.get(email)
            if ultimo is not None and agora - ultimo < self.COOLDOWN_EMAIL:
                return False
            if ip:
                fila = self._por_ip.setdefault(ip, deque())
                while fila and agora - fila[0] > self.JANELA_IP:
                    fila.popleft()
                if len(fila) >= self.MAX_POR_IP:
                    return False
                fila.append(agora)
            self._por_email[email] = agora
            return True

    def _podar(self, agora: float) -> None:
        if len(self._por_email) > self._MAX_ENTRADAS:
            self._por_email = {
                e: t for e, t in self._por_email.items() if agora - t < self.COOLDOWN_EMAIL
            }
        if len(self._por_ip) > self._MAX_ENTRADAS:
            self._por_ip = {
                ip: f for ip, f in self._por_ip.items() if f and agora - f[-1] < self.JANELA_IP
            }

    def limpar(self) -> None:
        with self._lock:
            self._por_email.clear()
            self._por_ip.clear()


_limitador = _Limitador()
_avisou_sem_secret = False


def _verificar_captcha(token: Optional[str], ip: Optional[str]) -> Optional[str]:
    """None = passou. "invalido" = recusado. "indisponivel" = não deu para
    verificar (falha aqui é FECHADA: sem verificação, sem e-mail)."""
    global _avisou_sem_secret
    settings = get_settings()
    if not settings.hcaptcha_secret:
        if not _avisou_sem_secret:
            _avisou_sem_secret = True
            nivel = logging.ERROR if settings.environment == "production" else logging.WARNING
            logger.log(nivel, "HCAPTCHA_SECRET ausente: o esqueci-senha está SEM verificação de captcha")
        return None
    if not token:
        return "invalido"

    dados = {"secret": settings.hcaptcha_secret, "response": token}
    if ip:
        dados["remoteip"] = ip
    try:
        r = httpx.post(_HCAPTCHA_URL, data=dados, timeout=10)
    except Exception:
        logger.exception("não foi possível falar com o hCaptcha")
        return "indisponivel"
    if r.status_code >= 500:
        logger.warning("hCaptcha respondeu %s", r.status_code)
        return "indisponivel"
    try:
        corpo = r.json() or {}
    except Exception:
        corpo = {}
    if corpo.get("success") is True:
        return None
    logger.info("captcha recusado: %s", corpo.get("error-codes"))
    return "invalido"


def _gerar_e_enviar(email: str, idioma: str) -> None:
    """Roda em background, depois da resposta. NUNCA levanta: uma exceção
    aqui some em silêncio (a resposta já foi), então TUDO fica dentro do
    try e cada falha vira log."""
    try:
        r = gerar_link("recovery", email)
        if r.status == 404:
            logger.info("esqueci-senha: e-mail sem conta, nada enviado")
            return
        if r.status == 429:
            logger.warning("esqueci-senha: limite do serviço de auth atingido, nada enviado")
            return
        if r.status >= 400 or not r.link:
            logger.error("esqueci-senha: serviço de auth recusou (%s): %s", r.status, r.texto)
            return
        assunto, html, texto = renderizar("redefinir_senha", idioma, link=r.link, email=email)
        motivo = enviar_email(email, assunto, html, texto, link=r.link)
        if motivo:
            logger.warning("esqueci-senha: e-mail para %s não saiu (%s)", email, motivo)
    except Exception:
        logger.exception("esqueci-senha: falha ao gerar/enviar o link para %s", email)


@router.post("/forgot-password")
def forgot_password(
    data: ForgotPasswordIn,
    request: Request,
    tarefas: BackgroundTasks,
    idioma: str = Depends(get_language),
):
    """Pede o link de redefinição de senha, no idioma da tela."""
    ip = ActivityLogService.client_ip(request)

    # Captcha ANTES do limitador: um robô sem captcha válido não pode queimar
    # o cooldown de uma vítima e deixá-la sem o link.
    motivo = _verificar_captcha(data.captcha_token, ip)
    if motivo == "indisponivel":
        raise erro_http(
            503, "verificacao_indisponivel",
            "Não foi possível verificar a segurança agora. Tente de novo em instantes.",
        )
    if motivo:
        raise recusado(
            "captcha_invalido",
            "Não foi possível confirmar a verificação de segurança. Tente de novo.",
        )

    email = str(data.email).lower()
    if not _limitador.permitir(email, ip):
        logger.info("esqueci-senha: pedido limitado (cooldown/IP)")
        return _RECEBIDO

    tarefas.add_task(_gerar_e_enviar, email, idioma)
    return _RECEBIDO
