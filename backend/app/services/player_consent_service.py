"""Consentimento do jogador para contatos futuros (LGPD).

Ao ser cadastrado, o jogador recebe um e-mail do clube pedindo autorização
para contatos promocionais (novidades, torneios, promoções). A resposta —
AUTORIZO ou NÃO AUTORIZO — é dada numa página pública, por um link com token.

TRÊS DECISÕES QUE ESTE ARQUIVO PROTEGE:

1. **O cadastro no balcão nunca espera pelo e-mail.** Token, marcação e envio
   rodam numa thread, com `supabase_admin` (a thread não tem o JWT da
   requisição). Qualquer falha — migração não aplicada, Resend fora — vira
   log, nunca erro na tela de quem cadastrou.

2. **O token é credencial: só o hash vai para o banco.** O valor puro existe
   apenas no link do e-mail. Vazou o banco, os links continuam inúteis.
   Uso único e validade de 30 dias.

3. **Quem não responde não autorizou.** `pending` (pedido enviado) e `NULL`
   (nunca pedido — a base antiga) valem como NÃO para qualquer contato. O
   reenvio só existe enquanto não há resposta: insistir com quem recusou não
   é pedir consentimento.
"""
import hashlib
import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.config import get_settings
from app.database.supabase_client import supabase_admin
from app.services.email_service import enviar_email, renderizar
from app.utils.erros import ErroDeNegocio
from app.utils.idioma import normalizar_idioma

logger = logging.getLogger(__name__)

VALIDADE = timedelta(days=30)
INTERVALO_MINIMO_REENVIO = timedelta(minutes=5)

# Poucas threads: um cadastro usa uma por meio segundo.
_envios = ThreadPoolExecutor(max_workers=4, thread_name_prefix="consentimento-email")


class _Ritmo:
    """Espaça os envios. O Resend recusa acima de ~2 requisições por segundo
    por conta, e uma importação de 500 jogadores dispararia tudo de uma vez —
    a maioria voltaria "recusado" e ficaria sem pedido."""

    def __init__(self, intervalo: float):
        self._intervalo = intervalo
        self._trava = threading.Lock()
        self._proximo = 0.0

    def esperar(self) -> None:
        with self._trava:
            agora = time.monotonic()
            espera = self._proximo - agora
            self._proximo = max(agora, self._proximo) + self._intervalo
        if espera > 0:
            time.sleep(espera)


_ritmo = _Ritmo(0.6)


def _agora() -> datetime:
    return datetime.now(timezone.utc)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _parse(ts) -> Optional[datetime]:
    if not ts:
        return None
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def email_contatavel(email: Optional[str]) -> bool:
    """Há para onde mandar? Cadastros antigos ganharam e-mail de mentira
    (`player_<id>@placeholder.com`) quando o campo virou obrigatório."""
    e = (email or "").strip().lower()
    return "@" in e and not e.endswith("@placeholder.com")


def _primeiro_nome(jogador: dict) -> str:
    nome = (jogador.get("first_name") or jogador.get("name") or "").strip()
    return nome.split()[0] if nome else ""


def _nome_da_organizacao(organization_id: Optional[str]) -> str:
    # `organizations` tem RLS sem policy: só o admin lê.
    if not organization_id:
        return "AceBlind"
    try:
        r = supabase_admin.table("organizations").select("name") \
            .eq("id", organization_id).limit(1).execute()
        if r.data:
            return r.data[0]["name"]
    except Exception:
        pass
    return "AceBlind"


def _idioma_do_clube(organization_id: Optional[str]) -> str:
    """O jogador não escolheu idioma nenhum: vale o padrão do clube, não o da
    tela de quem o cadastrou."""
    if not organization_id:
        return "pt-BR"
    try:
        r = supabase_admin.table("app_settings").select("language") \
            .eq("organization_id", organization_id).limit(1).execute()
        if r.data:
            return normalizar_idioma(r.data[0].get("language"))
    except Exception:
        pass
    return "pt-BR"


def _link(token: str) -> str:
    base = (get_settings().frontend_url or "https://aceblind.net").rstrip("/")
    return f"{base}/consentimento/{token}"


class PlayerConsentService:

    # ============================================================
    # Pedido (e-mail)
    # ============================================================

    @staticmethod
    def solicitar_em_segundo_plano(jogador: dict) -> bool:
        """Agenda o pedido para um jogador recém-gravado. Devolve se agendou.

        Não levanta: é chamado depois do cadastro já ter dado certo."""
        try:
            if not jogador or not email_contatavel(jogador.get("email")):
                return False
            if jogador.get("contact_consent") in ("granted", "denied"):
                return False
            _envios.submit(PlayerConsentService._solicitar, dict(jogador))
            return True
        except Exception:
            logger.exception("não foi possível agendar o pedido de consentimento")
            return False

    @staticmethod
    def _solicitar(jogador: dict) -> Optional[str]:
        """Gera o token, marca `pending` e manda o e-mail. Roda na thread."""
        try:
            player_id = jogador["id"]
            org = jogador.get("organization_id")
            token = secrets.token_urlsafe(32)
            agora = _agora()

            supabase_admin.table("player_consent_tokens").insert({
                "organization_id": org,
                "player_id": player_id,
                "token_hash": _hash(token),
                "expires_at": (agora + VALIDADE).isoformat(),
            }).execute()
            supabase_admin.table("players").update({
                "contact_consent": "pending",
                "contact_consent_requested_at": agora.isoformat(),
            }).eq("id", player_id).execute()

            link = _link(token)
            assunto, html, texto = renderizar(
                "consentimento_contato",
                _idioma_do_clube(org),
                link=link,
                nome=_primeiro_nome(jogador),
                org=_nome_da_organizacao(org),
            )
            _ritmo.esperar()
            return enviar_email(jogador["email"], assunto, html, texto, link=link)
        except Exception:
            logger.exception("falha ao pedir consentimento ao jogador %s", jogador.get("id"))
            return "falhou"

    @staticmethod
    def reenviar(player_id: str) -> dict:
        """Botão "Reenviar pedido" da ficha do jogador."""
        r = supabase_admin.table("players").select(
            "id, organization_id, name, first_name, email, contact_consent, contact_consent_requested_at"
        ).eq("id", player_id).limit(1).execute()
        if not r.data:
            raise ErroDeNegocio("jogador_nao_encontrado", "Jogador não encontrado.", status=404)
        jogador = r.data[0]

        if jogador.get("contact_consent") in ("granted", "denied"):
            raise ErroDeNegocio(
                "consentimento_ja_respondido",
                "O jogador já respondeu ao pedido de contato.",
                status=409, status_atual=jogador["contact_consent"],
            )
        if not email_contatavel(jogador.get("email")):
            raise ErroDeNegocio(
                "jogador_sem_email_valido",
                "O jogador não tem um e-mail válido cadastrado.",
            )
        ultimo = _parse(jogador.get("contact_consent_requested_at"))
        if ultimo and _agora() - ultimo < INTERVALO_MINIMO_REENVIO:
            raise ErroDeNegocio(
                "consentimento_reenviado_recentemente",
                "O pedido acabou de ser enviado. Aguarde alguns minutos para reenviar.",
                status=429,
            )

        _envios.submit(PlayerConsentService._solicitar, jogador)
        return {"sent": True, "contact_consent": "pending"}

    # ============================================================
    # Resposta (página pública)
    # ============================================================

    @staticmethod
    def _token_valido(token: str) -> dict:
        if not token or len(token) > 200:
            raise ErroDeNegocio("link_invalido", "Link inválido.", status=404)
        r = supabase_admin.table("player_consent_tokens").select("*") \
            .eq("token_hash", _hash(token)).limit(1).execute()
        if not r.data:
            raise ErroDeNegocio("link_invalido", "Link inválido.", status=404)
        return r.data[0]

    @staticmethod
    def _jogador(player_id: str) -> dict:
        r = supabase_admin.table("players").select(
            "id, organization_id, name, first_name, contact_consent, contact_consent_at"
        ).eq("id", player_id).limit(1).execute()
        if not r.data:
            raise ErroDeNegocio("link_invalido", "Link inválido.", status=404)
        return r.data[0]

    @staticmethod
    def resolver(token: str) -> dict:
        """O que a página pública mostra: de qual clube, para quem, e se já
        foi respondido. Não devolve e-mail, documento nem nada além do primeiro
        nome — o link pode ter sido encaminhado."""
        linha = PlayerConsentService._token_valido(token)
        jogador = PlayerConsentService._jogador(linha["player_id"])
        expirado = (_parse(linha.get("expires_at")) or _agora()) < _agora()
        return {
            "organization_name": _nome_da_organizacao(linha.get("organization_id")),
            "player_first_name": _primeiro_nome(jogador),
            "status": jogador.get("contact_consent"),
            "answered_at": jogador.get("contact_consent_at"),
            "used": bool(linha.get("used_at")),
            "expired": expirado and not linha.get("used_at"),
        }

    @staticmethod
    def responder(token: str, aceita: bool) -> dict:
        linha = PlayerConsentService._token_valido(token)
        if linha.get("used_at"):
            raise ErroDeNegocio(
                "link_ja_usado", "Este link já foi usado para responder.", status=409,
            )
        if (_parse(linha.get("expires_at")) or _agora()) < _agora():
            raise ErroDeNegocio(
                "link_expirado", "Este link expirou. Peça ao clube um novo.", status=410,
            )

        agora = _agora().isoformat()
        # Compare-and-set no token: dois cliques (ou dois aparelhos) não
        # gravam duas respostas diferentes.
        marcado = supabase_admin.table("player_consent_tokens") \
            .update({"used_at": agora}) \
            .eq("id", linha["id"]).is_("used_at", "null").execute()
        if not marcado.data:
            raise ErroDeNegocio(
                "link_ja_usado", "Este link já foi usado para responder.", status=409,
            )

        status = "granted" if aceita else "denied"
        supabase_admin.table("players").update({
            "contact_consent": status,
            "contact_consent_at": agora,
        }).eq("id", linha["player_id"]).execute()
        return {"status": status, "answered_at": agora}
