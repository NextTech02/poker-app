"""Pagamento dividido ("pago mixto"): uma venda paga com vários meios.

A venda continua sendo UMA linha por item — relatórios, bolsa, fichas, rake,
KO, fidelidade e estorno contam por linha, e partir a venda em duas contaria a
entrada duas vezes. As partes moram na própria linha:

    payment_method = 'split'
    payment_split  = [{"payment_method": "cash", "amount": 300},
                      {"payment_method": "transfer", "amount": 200}]

O banco confere a mesma regra (CHECK `transactions_pagamento_dividido` e
`cash_tx_pagamento_dividido`, migração `pagamento_dividido`); aqui ela é
conferida ANTES de qualquer escrita, para recusar com nome e sem deixar
inscrição, cadeira ou contador pela metade.

Todo agregado por meio lê as partes por `pernas_da_linha` — nunca o
`payment_method` cru, que numa venda dividida é só 'split'.
"""
import json
import logging
from decimal import Decimal, InvalidOperation
from typing import Iterable, List, Optional, Tuple

from app.database import supabase
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

METODO_DIVIDIDO = "split"

# Não são meios de pagamento de dinheiro: crédito de patrocinador, fiado e
# ticket movem outra coisa e têm o seu próprio caminho.
_MEIOS_PROIBIDOS = {METODO_DIVIDIDO, "credit", "mixed", "house_credit", "ticket"}

_CENTAVO = Decimal("0.01")

# Coluna conferida por tabela; só o SIM fica guardado (a migração pode chegar
# com o backend no ar).
_coluna_ok: dict = {}


def _centavos(valor) -> Decimal:
    try:
        return Decimal(str(valor)).quantize(_CENTAVO)
    except (InvalidOperation, ValueError, TypeError):
        raise ErroDeNegocio(
            "pagamento_dividido_invalido", "Valor inválido no pagamento dividido."
        )


def _valor_da_parte(parte) -> Tuple[str, Decimal]:
    metodo = getattr(parte, "payment_method", None)
    valor = getattr(parte, "amount", None)
    if isinstance(parte, dict):
        metodo, valor = parte.get("payment_method"), parte.get("amount")
    metodo = (metodo or "").strip()
    if not metodo or metodo in _MEIOS_PROIBIDOS:
        raise ErroDeNegocio(
            "pagamento_dividido_meio_invalido",
            "Meio de pagamento inválido numa das partes.",
            meio=metodo or None,
        )
    try:
        bruto = Decimal(str(valor))
    except (InvalidOperation, ValueError, TypeError):
        raise ErroDeNegocio(
            "pagamento_dividido_invalido", "Valor inválido no pagamento dividido."
        )
    if bruto <= 0 or bruto != bruto.quantize(_CENTAVO):
        # Mais de 2 casas não é arredondado em silêncio: a soma deixaria de
        # bater com o que o operador digitou.
        raise ErroDeNegocio(
            "pagamento_dividido_invalido", "Cada parte precisa de um valor positivo, em centavos."
        )
    return metodo, bruto


def resolver(
    payment_method: Optional[str],
    partes: Optional[Iterable],
    valor,
    payment_source: Optional[str] = None,
) -> Tuple[Optional[str], Optional[List[dict]]]:
    """Devolve (`payment_method`, `payment_split`) a gravar na linha.

    Sem partes, nada muda: a venda é de um meio só, como sempre foi. Com
    partes, `valor` é o da venda CALCULADO NO SERVIDOR (o meio de entrada manda
    no preço) e as partes têm de fechá-lo exatamente.

    Partes do mesmo meio são somadas; se sobrar uma só, a venda vira simples.
    """
    partes = list(partes or [])
    if not partes:
        if payment_method == METODO_DIVIDIDO:
            raise ErroDeNegocio(
                "pagamento_dividido_sem_partes",
                "Pagamento dividido sem as partes: informe quanto foi pago em cada meio.",
            )
        return payment_method, None

    if payment_source == "house_credit":
        raise ErroDeNegocio(
            "pagamento_dividido_com_fiado",
            "Venda no fiado não pode ser dividida com outros meios.",
        )
    if payment_source not in (None, "cash"):
        raise ErroDeNegocio(
            "pagamento_dividido_com_credito",
            "Venda com crédito ou ticket não pode ser dividida.",
        )

    somadas: dict = {}
    for parte in partes:
        metodo, quanto = _valor_da_parte(parte)
        somadas[metodo] = somadas.get(metodo, Decimal("0")) + quanto

    total = _centavos(valor)
    soma = sum(somadas.values(), Decimal("0"))
    if soma != total:
        raise ErroDeNegocio(
            "pagamento_dividido_nao_fecha",
            "As partes do pagamento não somam o valor da venda.",
            status=409,
            valor=float(total),
            soma=float(soma),
        )

    if len(somadas) == 1:
        return next(iter(somadas)), None
    return METODO_DIVIDIDO, [
        {"payment_method": metodo, "amount": float(quanto)} for metodo, quanto in somadas.items()
    ]


def pernas_da_linha(row: dict) -> List[Tuple[Optional[str], Decimal]]:
    """(meio, valor) de cada parte da linha; linha simples = uma parte só."""
    partes = row.get("payment_split")
    if isinstance(partes, str):
        try:
            partes = json.loads(partes)
        except ValueError:
            partes = None
    if isinstance(partes, list) and partes:
        return [
            (p.get("payment_method") or None, Decimal(str(p.get("amount") or 0)))
            for p in partes
            if isinstance(p, dict)
        ]
    return [(row.get("payment_method") or None, Decimal(str(row.get("amount") or 0)))]


def somar_por_meio(rows: Iterable[dict]) -> List[Tuple[Optional[str], Decimal, int]]:
    """(meio, total, partes) somando as partes de cada linha, maior primeiro."""
    somas: dict = {}
    for row in rows:
        for metodo, quanto in pernas_da_linha(row):
            total, qtd = somas.get(metodo, (Decimal("0"), 0))
            somas[metodo] = (total + quanto, qtd + 1)
    linhas = [(metodo, total, qtd) for metodo, (total, qtd) in somas.items()]
    linhas.sort(key=lambda item: (-item[1], item[0] or ""))
    return linhas


def _blob(exc: Exception) -> str:
    partes = [str(exc)]
    for atributo in ("code", "message", "details", "hint"):
        valor = getattr(exc, atributo, None)
        if valor:
            partes.append(str(valor))
    return " ".join(partes).lower()


def _falta_a_coluna(exc: Exception) -> bool:
    blob = _blob(exc)
    return "payment_split" in blob and any(
        sinal in blob for sinal in ("pgrst204", "42703", "could not find", "does not exist", "não existe")
    )


def _indisponivel() -> ErroDeNegocio:
    return ErroDeNegocio(
        "pagamento_dividido_indisponivel",
        "O pagamento dividido ainda não está disponível neste servidor. Registre a venda em um meio só.",
        status=409,
    )


def exigir_coluna(tabela: str) -> None:
    """Antes de gravar uma venda dividida: o banco já tem a coluna? Sem ela a
    venda é recusada ANTES de qualquer escrita — senão a inscrição (ou a
    cadeira) ficaria gravada sem a venda."""
    if _coluna_ok.get(tabela):
        return
    try:
        supabase.table(tabela).select("payment_split").limit(1).execute()
    except Exception as exc:
        if _falta_a_coluna(exc):
            logger.warning("%s.payment_split indisponível; pagamento dividido desligado até a migração", tabela)
            raise _indisponivel()
        raise
    _coluna_ok[tabela] = True


def traduzir_erro(exc: Exception) -> None:
    """Se a falha do banco é do pagamento dividido, relança com nome; senão
    volta e quem chamou relança a original."""
    if _falta_a_coluna(exc):
        raise _indisponivel()
    blob = _blob(exc)
    if "pagamento_dividido" in blob and ("23514" in blob or "check" in blob):
        raise ErroDeNegocio(
            "pagamento_dividido_invalido",
            "As partes do pagamento não fecham o valor da venda.",
            status=409,
        )
