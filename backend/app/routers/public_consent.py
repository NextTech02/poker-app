"""Rotas PÚBLICAS (sem login) da resposta do jogador ao pedido de contato.

O jogador chega aqui pelo link do e-mail (`/consentimento/<token>` no app).
Quem autentica é o token — de uso único, 30 dias, e guardado só como hash.

Um limite por IP (por processo, como o do esqueci-senha) segura quem tentar
adivinhar tokens: 32 bytes aleatórios já tornam isso inviável, o limite só
evita o barulho.
"""
import threading
import time
from collections import deque
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.services.player_consent_service import PlayerConsentService
from app.utils.erros import ErroDeNegocio, da_excecao

router = APIRouter(prefix="/public/consent", tags=["public"])


class ConsentAnswer(BaseModel):
    accept: bool


class _LimitePorIp:
    JANELA = 15 * 60
    MAXIMO = 60
    _MAX_ENTRADAS = 5000

    def __init__(self):
        self._lock = threading.Lock()
        self._por_ip = {}

    def permitir(self, ip: Optional[str]) -> bool:
        if not ip:
            return True
        agora = time.monotonic()
        with self._lock:
            if len(self._por_ip) > self._MAX_ENTRADAS:
                self._por_ip = {k: f for k, f in self._por_ip.items() if f and agora - f[-1] < self.JANELA}
            fila = self._por_ip.setdefault(ip, deque())
            while fila and agora - fila[0] > self.JANELA:
                fila.popleft()
            if len(fila) >= self.MAXIMO:
                return False
            fila.append(agora)
            return True

    def limpar(self) -> None:
        with self._lock:
            self._por_ip.clear()


_limite = _LimitePorIp()


def _ip(request: Request) -> Optional[str]:
    # Atrás do Cloudflare Tunnel o IP real vem no cabeçalho.
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else None)


def _barrar_excesso(request: Request) -> None:
    if not _limite.permitir(_ip(request)):
        raise ErroDeNegocio(
            "muitas_tentativas", "Muitas tentativas. Tente de novo em alguns minutos.", status=429,
        ).como_http()


@router.get("/{token}")
def ver_pedido(token: str, request: Request):
    _barrar_excesso(request)
    try:
        return PlayerConsentService.resolver(token)
    except ValueError as e:
        raise da_excecao(e, "link_invalido", status=404)


@router.post("/{token}")
def responder_pedido(token: str, body: ConsentAnswer, request: Request):
    _barrar_excesso(request)
    try:
        return PlayerConsentService.responder(token, body.accept)
    except ValueError as e:
        raise da_excecao(e, "link_invalido", status=404)
