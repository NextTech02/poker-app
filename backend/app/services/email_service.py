"""Monta e envia os e-mails transacionais do sistema (Resend), no idioma certo.

Antes cada envio era um `httpx.post` solto no router, e três dos quatro
e-mails nem passavam por aqui: o Supabase mandava o template global do painel
— em inglês, para todo mundo. Agora o app gera o link (sem enviar) e redige o
e-mail ele mesmo, no idioma da tela de quem disparou a ação.

Três peças:

- `renderizar(tipo, idioma, link=..., **valores)` → (assunto, html, texto). Os
  textos vivem em `email_textos.py`; o layout é o mesmo para todos (o de
  docs/email-templates/invite.html: tabela, cabeçalho roxo, botão, aviso).
- `enviar_email(...)` → None quando saiu, ou um código curto do motivo. NUNCA
  levanta: e-mail que não sai é problema de reenviar, e derrubar a resposta
  faria o operador achar que nada foi criado.
- Sem RESEND_API_KEY em desenvolvimento, o LINK vai para o log: é assim que se
  testa o fluxo inteiro sem caixa de e-mail.

`httpx.post` é chamado como atributo do módulo de propósito — os testes trocam
`httpx.post` por um fake, e `from httpx import post` escaparia dessa troca.
"""
import html as _html
import logging
import re
from string import Template
from typing import Optional

import httpx

from app.config import get_settings
from app.services.email_textos import COMUNS, TEXTOS
from app.utils.idioma import normalizar_idioma

logger = logging.getLogger(__name__)

_RESEND_URL = "https://api.resend.com/emails"
_NEGRITO = re.compile(r"\*\*(.+?)\*\*")

# HTML "antiquado" de propósito: <table>, estilos inline e larguras fixas são o
# que sobrevive ao Outlook e ao Gmail. Nada de flex/grid. `string.Template`
# (e não str.format) porque o CSS inline está cheio de chaves.
_LAYOUT = Template("""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#f4f4f8;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,16,40,0.08);font-family:Helvetica,Arial,sans-serif;">
        <tr>
          <td align="center" bgcolor="#7233f8" style="background-color:#7233f8;padding:28px 24px;">
            <img src="$logo" width="56" height="56" alt="AceBlind" style="display:block;border:0;outline:none;text-decoration:none;width:56px;height:56px;border-radius:14px;" />
            <div style="margin-top:12px;font-size:22px;line-height:26px;font-weight:bold;color:#ffffff;letter-spacing:-0.3px;">AceBlind</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 36px 8px 36px;">
            <h1 style="margin:0 0 16px 0;font-size:21px;line-height:28px;color:#1c1830;font-weight:bold;text-align:center;">$titulo</h1>
$paragrafos
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px auto;">
              <tr>
                <td align="center" bgcolor="#7233f8" style="background-color:#7233f8;border-radius:10px;">
                  <a href="$link" style="display:inline-block;padding:15px 34px;font-size:16px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">$cta</a>
                </td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f6f3ff;border-left:3px solid #7233f8;border-radius:6px;margin-bottom:24px;">
              <tr>
                <td style="padding:14px 16px;font-size:13px;line-height:20px;color:#4a4560;text-align:center;">$aviso</td>
              </tr>
            </table>
            <p style="margin:0 0 8px 0;font-size:13px;line-height:20px;color:#7b7590;text-align:center;">$se_nao_funcionar</p>
            <p style="margin:0 0 28px 0;font-size:12px;line-height:19px;word-break:break-all;text-align:center;"><a href="$link" style="color:#7233f8;text-decoration:underline;">$link</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 36px 32px 36px;">
            <div style="border-top:1px solid #eceaf4;padding-top:18px;font-size:12px;line-height:19px;color:#8d87a0;text-align:center;">$rodape</div>
            <div style="text-align:center;padding-top:16px;font-size:12px;line-height:19px;color:#8d87a0;"><a href="https://aceblind.net" style="color:#7233f8;text-decoration:none;">$marca</a></div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>""")

_PARAGRAFO = '            <p style="margin:0 0 16px 0;font-size:15px;line-height:24px;color:#4a4560;text-align:center;">%s</p>'

# O ícone é servido pelo próprio app (frontend/public/icon-192.png). O
# template antigo apontava para aceblind.net — a LANDING, que não tem o
# arquivo — e a logo chegava quebrada. Em desenvolvimento o FRONTEND_URL é
# localhost, inalcançável de qualquer caixa de e-mail: cai no domínio real.
_APP_PUBLICO = "https://app.aceblind.net"


def _url_da_logo() -> str:
    base = (get_settings().frontend_url or "").rstrip("/")
    if not base.startswith("https://") or "localhost" in base or "127.0.0.1" in base:
        base = _APP_PUBLICO
    return base + "/icon-192.png"


def _preencher(modelo: str, valores: dict) -> str:
    """Troca {nome}/{org}/{email} pelos valores. Sem str.format: um valor com
    chaves ("Clube {A}") não pode virar erro nem marcador."""
    for chave, valor in valores.items():
        modelo = modelo.replace("{" + chave + "}", valor)
    return modelo


def _como_html(frase: str) -> str:
    return _NEGRITO.sub(r'<strong style="color:#1c1830;">\1</strong>', frase)


def _como_texto(frase: str) -> str:
    return _NEGRITO.sub(r"\1", frase)


def renderizar(tipo: str, idioma: str, *, link: str, **valores) -> tuple:
    """Devolve (assunto, html, texto) do e-mail `tipo` no `idioma`.

    Idioma desconhecido cai em pt-BR; tipo desconhecido é erro de programação
    (KeyError). No HTML todo valor passa por `html.escape` ANTES de entrar na
    frase — inclusive o link, cujo `&` vira `&amp;` (correto dentro de href e
    no texto visível). No texto puro os valores vão crus.
    """
    idioma = normalizar_idioma(idioma)
    t = TEXTOS[tipo][idioma]
    comuns = COMUNS[idioma]
    crus = {k: str(v if v is not None else "") for k, v in valores.items()}
    escapados = {k: _html.escape(v, quote=True) for k, v in crus.items()}
    link_html = _html.escape(link, quote=True)

    assunto = _como_texto(_preencher(t["assunto"], crus))

    paragrafos_html = "\n".join(
        _PARAGRAFO % _como_html(_preencher(p, escapados)) for p in t["paragrafos"]
    )
    html = _LAYOUT.substitute(
        logo=_url_da_logo(),
        titulo=_como_html(_preencher(t["titulo"], escapados)),
        paragrafos=paragrafos_html,
        link=link_html,
        cta=_como_html(_preencher(t["cta"], escapados)),
        aviso=_como_html(t["aviso"]),
        se_nao_funcionar=comuns["se_nao_funcionar"],
        rodape=_como_html(t["rodape"]),
        marca=comuns["marca"],
    )

    partes = [
        _como_texto(_preencher(t["titulo"], crus)),
        *[_como_texto(_preencher(p, crus)) for p in t["paragrafos"]],
        _como_texto(_preencher(t["cta"], crus)) + ": " + link,
        _como_texto(t["aviso"]),
        comuns["se_nao_funcionar"] + "\n" + link,
        _como_texto(t["rodape"]),
        comuns["marca"],
    ]
    texto = "\n\n".join(partes)
    return assunto, html, texto


def enviar_email(para: str, assunto: str, html: str, texto: str, *, link: Optional[str] = None) -> Optional[str]:
    """Manda pelo Resend. Devolve None se saiu, ou o motivo:

    - "sem_chave": RESEND_API_KEY não configurada (nem tentou);
    - "recusado": o provedor respondeu erro (chave errada, cota, remetente);
    - "indisponivel": não deu para falar com o provedor.

    Nunca levanta. Sem chave FORA de produção, o link vai para o log em INFO —
    é o jeito de testar convite e recuperação de senha ponta a ponta sem caixa
    de e-mail. Em produção o link é credencial e não aparece no log.
    """
    settings = get_settings()
    if not settings.resend_api_key:
        if link and settings.environment != "production":
            logger.info(
                "[dev] e-mail NÃO enviado (RESEND_API_KEY ausente) para %s — %s — link: %s",
                para, assunto, link,
            )
        else:
            logger.warning("e-mail não enviado para %s: RESEND_API_KEY ausente", para)
        return "sem_chave"

    try:
        r = httpx.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.leads_email_from,
                "to": [para],
                "subject": assunto,
                "html": html,
                "text": texto,
            },
            timeout=15,
        )
    except Exception:
        logger.exception("falha ao contatar o Resend para enviar a %s", para)
        return "indisponivel"

    if r.status_code >= 400:
        # O corpo pode trazer chave e detalhe do provedor: só no log.
        logger.warning("Resend recusou o e-mail para %s (%s): %s", para, r.status_code, r.text[:300])
        return "recusado"
    return None
