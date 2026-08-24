"""Rota PÚBLICA (sem auth) para o formulário da landing page.

É a única porta do sistema aberta para a internet inteira escrever. Por isso a
regra aqui é diferente do resto da API:

- O lead é GRAVADO primeiro e o e-mail sai depois. Notificação falha (cota do
  provedor, chave errada, rede), e um formulário que só manda e-mail perde o
  cliente em silêncio: a pessoa lê "recebemos" e ninguém recebeu nada.
- Falha no e-mail NÃO vira erro na tela. O pedido já está guardado; dizer
  "deu errado" faria a pessoa desistir de algo que funcionou.
- Escreve com service_role de propósito: não há usuário logado, e a tabela
  `leads` tem RLS sem nenhuma policy — ninguém a alcança pela chave pública.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, field_validator

from app.config import get_settings
from app.database.supabase_client import supabase_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["public"])

# Recado devolvido em QUALQUER desfecho que não seja erro de preenchimento —
# inclusive quando o e-mail de aviso não sai. Do lado de quem preencheu, o
# pedido chegou; o resto é problema nosso.
_RECEBIDO = {"received": True}


class LeadIn(BaseModel):
    """O que a landing manda. Limites curtos: campo livre aberto para a
    internet é onde entra texto de spam com quilobytes de link."""

    name: str = Field(..., min_length=2, max_length=120)
    club: str = Field(..., min_length=2, max_length=120)
    whatsapp: str = Field(..., min_length=8, max_length=40)
    email: EmailStr
    city: Optional[str] = Field(None, max_length=120)
    events_per_month: Optional[str] = Field(None, max_length=40)
    source: str = Field("landing", max_length=60)
    # Campo-armadilha: fica escondido na página, gente não preenche, robô de
    # formulário preenche tudo que encontra. Chegou com conteúdo, é robô.
    website: Optional[str] = Field(None, max_length=200)

    @field_validator("name", "club", "city", "whatsapp", mode="before")
    @classmethod
    def _aparar(cls, v):
        return v.strip() if isinstance(v, str) else v


@router.post("/leads", status_code=status.HTTP_201_CREATED)
def create_lead(data: LeadIn):
    """Registra um pedido de contato da landing page."""
    if data.website:
        # Robô. Responde como se tivesse dado certo — dizer "recusado" só
        # ensina o próximo robô a não preencher a armadilha.
        logger.info("lead descartado pela armadilha anti-robô")
        return _RECEBIDO

    linha = {
        "name": data.name,
        "club": data.club,
        "whatsapp": data.whatsapp,
        "email": str(data.email).lower(),
        "city": data.city or None,
        "events_per_month": data.events_per_month or None,
        "source": data.source or "landing",
    }

    try:
        gravado = supabase_admin.table("leads").insert(linha).execute()
        lead_id = (gravado.data or [{}])[0].get("id")
    except Exception as exc:
        # O índice único (e-mail + dia) barra o clique repetido e a rede que
        # reenviou. Do lado de quem preencheu isso é sucesso: o pedido já está
        # registrado, e uma segunda linha só daria trabalho a quem vai ligar.
        if _e_repetido(exc):
            logger.info("lead repetido no mesmo dia — ignorado")
            return _RECEBIDO
        logger.exception("falha ao gravar lead da landing")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Não consegui registrar seu pedido agora. "
                "Tente de novo em instantes ou chame no WhatsApp."
            ),
        )

    _avisar_por_email(linha, lead_id)
    return _RECEBIDO


def _e_repetido(exc: Exception) -> bool:
    texto = str(exc).lower()
    return "uq_leads_email_dia" in texto or "duplicate key" in texto


def _avisar_por_email(linha: dict, lead_id: Optional[str]) -> None:
    """Manda o aviso e carimba `notified_at`. Nunca levanta exceção.

    Sem chave configurada, não é erro: o lead está no banco e aparece na lista.
    O aviso é conveniência, não o registro.
    """
    settings = get_settings()
    if not settings.resend_api_key or not settings.leads_email_to:
        logger.info("aviso de lead não enviado: RESEND_API_KEY/LEADS_EMAIL_TO ausentes")
        return

    corpo = "\n".join([
        f"Nome:      {linha['name']}",
        f"Clube:     {linha['club']}",
        f"WhatsApp:  {linha['whatsapp']}",
        f"E-mail:    {linha['email']}",
        f"Cidade:    {linha['city'] or '—'}",
        f"Eventos:   {linha['events_per_month'] or '—'}",
        f"Origem:    {linha['source']}",
    ])

    try:
        r = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.leads_email_from,
                "to": [e.strip() for e in settings.leads_email_to.split(",") if e.strip()],
                # Responder o e-mail cai direto em quem pediu contato, em vez de
                # voltar para o remetente automático.
                "reply_to": linha["email"],
                "subject": f"Novo lead AceBlind — {linha['club']}",
                "text": corpo,
            },
            timeout=10,
        )
        if r.status_code >= 400:
            logger.warning("Resend recusou o aviso de lead: %s", r.text[:200])
            return
    except Exception:
        logger.exception("falha ao enviar aviso de lead")
        return

    if lead_id:
        try:
            # Instante em ISO, não a string "now()": o PostgREST manda o valor
            # como texto e gravaria literalmente "now()" na coluna.
            supabase_admin.table("leads").update(
                {"notified_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", lead_id).execute()
        except Exception:
            # O aviso saiu; o carimbo é só para saber quais ficaram sem aviso.
            logger.warning("aviso enviado, mas não consegui carimbar notified_at")
