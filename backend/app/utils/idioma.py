"""Idioma da interface, do jeito que chega no header e do jeito que usamos.

O app fala três idiomas (pt-BR, en-US, es-ES). O navegador, porém, manda o que
quiser: "es" puro, "es-419", "en-GB", "pt_BR" com sublinhado, ou nada. Tudo
isso precisa cair em UM dos três — e, na dúvida, em português, que é o idioma
padrão do produto (e o do `fallbackLng` do frontend).

Serve para escolher o idioma de e-mails e textos gerados pelo servidor. Não é
autorização nem contexto de dados: um X-Language errado só muda a língua.
"""
from typing import Optional

IDIOMAS_SUPORTADOS = ("pt-BR", "en-US", "es-ES")
IDIOMA_PADRAO = "pt-BR"

_POR_CODIGO = {c.lower(): c for c in IDIOMAS_SUPORTADOS}
_POR_PREFIXO = {"pt": "pt-BR", "en": "en-US", "es": "es-ES"}


def normalizar_idioma(codigo: Optional[str]) -> str:
    """Devolve um dos três idiomas suportados a partir de qualquer código.

    "EN-us" e "pt_BR" batem por igualdade (sem caixa, com hífen); "es-419" e
    "en-GB" batem pelo prefixo de duas letras; "fr-FR", vazio e None caem no
    padrão.
    """
    if not codigo or not isinstance(codigo, str):
        return IDIOMA_PADRAO
    limpo = codigo.strip().replace("_", "-")
    if not limpo:
        return IDIOMA_PADRAO
    exato = _POR_CODIGO.get(limpo.lower())
    if exato:
        return exato
    return _POR_PREFIXO.get(limpo[:2].lower(), IDIOMA_PADRAO)
