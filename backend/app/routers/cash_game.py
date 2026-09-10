"""Rotas do módulo de CASH GAME.

Prefixo `/cash-game`, e não `/cash`: o router do caixa da etapa já ocupa `/cash`
(sangria, rake, caixa geral) e uma sub-rota nova ali colidiria com as dele.

O escopo viaja EXPLÍCITO (`cash_day_id` no caminho ou na query), não num header.
O `X-Stage-ID` do torneio existe porque a etapa é um filtro de visão dentro da
organização; aqui não há nada a esconder atrás de um header, e um segundo
cabeçalho mágico só criaria mais um lugar onde o escopo pode estar errado sem
aparecer na URL.

Quem barra o acesso de fora é `require_module("cash")`, aplicado em bloco no
main.py: permissão diz quem opera, módulo diz se o clube contratou.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.dependencies import get_org_id_optional
from app.models.cash_game import (
    CashDayClose,
    CashDayCreate,
    CashDayResponse,
    CashDaySummary,
    CashGameTypeCreate,
    CashGameTypeResponse,
    CashGameTypeUpdate,
    CashPlayerSessionResponse,
    CashRakeEntryCreate,
    CashRakeEntryResponse,
    CashRebuy,
    CashSeatResponse,
    CashTableClose,
    CashTableCreate,
    CashTableResponse,
    CashTableUpdate,
    CashTransactionCancel,
    CashTransactionResponse,
    SitPlayer,
    SitPlayerResult,
    StandPlayer,
)
from app.services.cash_day_service import CashDayService
from app.services.cash_game_type_service import CashGameTypeService
from app.services.cash_table_service import CashTableService
from app.services.cash_transaction_service import CashTransactionService
from app.utils.erros import da_excecao

router = APIRouter(prefix="/cash-game", tags=["cash-game"])

_operar   = Depends(require_permission("cash.operate"))
_mesas    = Depends(require_permission("cash.tables", "cash.operate"))
_dia      = Depends(require_permission("cash.day"))
_admin    = Depends(require_permission("cash.admin"))
_relatar  = Depends(require_permission("cash.reports", "cash.day", "cash.operate"))


# ══════════════════════════════════════════════════════════════════════
# Dia de operação
# ══════════════════════════════════════════════════════════════════════

@router.post("/days", response_model=CashDayResponse)
def open_day(
    data: CashDayCreate,
    user=_dia,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Abre o dia. A data vem do formulário, não do relógio — a noite que
    atravessa a meia-noite é um dia só."""
    try:
        return CashDayService.open_day(data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


# Antes de /days/{cash_day_id}: senão "current" seria lido como um id.
@router.get("/days/current", response_model=Optional[CashDayResponse])
def current_day(
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """O dia aberto agora, ou nulo. É como a tela do salão sabe se a operação
    está no ar."""
    return CashDayService.get_current(organization_id)


@router.get("/days", response_model=List[CashDayResponse])
def list_days(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(90, ge=1, le=400),
    user=_relatar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return CashDayService.list_days(organization_id, date_from, date_to, status, limit)


@router.get("/days/{cash_day_id}", response_model=CashDayResponse)
def get_day(cash_day_id: str, user=Depends(get_current_user)):
    try:
        return CashDayResponse(**CashDayService.get_day(cash_day_id))
    except ValueError as e:
        raise da_excecao(e)


@router.get("/days/{cash_day_id}/summary", response_model=CashDaySummary)
def day_summary(cash_day_id: str, user=Depends(get_current_user)):
    try:
        return CashDayService.summary(cash_day_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/days/{cash_day_id}/close", response_model=CashDayResponse)
def close_day(cash_day_id: str, data: CashDayClose, user=_dia):
    """Fecha o dia e CONGELA o faturamento. Recusa com mesa aberta: o número
    congelado nasceria antes da última apuração de rake."""
    try:
        return CashDayService.close_day(cash_day_id, user.get("sub"), data.notes)
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Modalidades (stakes)
# ══════════════════════════════════════════════════════════════════════

@router.get("/game-types", response_model=List[CashGameTypeResponse])
def list_game_types(
    active: Optional[bool] = None,
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return CashGameTypeService.list_types(organization_id, active)


@router.post("/game-types", response_model=CashGameTypeResponse)
def create_game_type(
    data: CashGameTypeCreate,
    user=_admin,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    try:
        return CashGameTypeService.create(data, organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.patch("/game-types/{type_id}", response_model=CashGameTypeResponse)
def update_game_type(type_id: str, data: CashGameTypeUpdate, user=_admin):
    try:
        return CashGameTypeService.update(type_id, data)
    except ValueError as e:
        raise da_excecao(e)


@router.delete("/game-types/{type_id}")
def delete_game_type(type_id: str, user=_admin):
    """Modalidade já usada por uma mesa é desativada, não apagada — o histórico
    perderia o nome pelo qual o clube chama a mesa."""
    try:
        return CashGameTypeService.delete(type_id)
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Mesas
# ══════════════════════════════════════════════════════════════════════

@router.get("/tables", response_model=List[CashTableResponse])
def list_tables(
    cash_day_id: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return CashTableService.list_tables(cash_day_id, status, organization_id)


@router.post("/tables", response_model=CashTableResponse)
def open_table(
    data: CashTableCreate,
    user=_mesas,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Abre a mesa copiando stakes e rake da modalidade. O retrato é
    deliberado: mudar a modalidade amanhã não pode reescrever a apuração de
    hoje."""
    try:
        return CashTableService.open_table(data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.get("/tables/{table_id}", response_model=CashTableResponse)
def get_table(table_id: str, user=Depends(get_current_user)):
    try:
        return CashTableService.get_table_enriched(table_id)
    except ValueError as e:
        raise da_excecao(e)


@router.patch("/tables/{table_id}", response_model=CashTableResponse)
def update_table(table_id: str, data: CashTableUpdate, user=_mesas):
    try:
        return CashTableService.update_table(table_id, data)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/tables/{table_id}/close", response_model=CashTableResponse)
def close_table(table_id: str, data: CashTableClose, user=_mesas):
    """Fecha a mesa APURANDO o rake contado. É aqui que a receita do cash vira
    número — o sistema não vê mão a mão."""
    try:
        return CashTableService.close_table(table_id, data, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)


@router.get("/tables/{table_id}/seats", response_model=List[CashSeatResponse])
def list_seats(table_id: str, user=Depends(get_current_user)):
    return CashTableService.list_seats(table_id)


@router.get("/tables/{table_id}/rake-entries", response_model=List[CashRakeEntryResponse])
def list_rake_entries(table_id: str, user=_relatar):
    return CashTableService.list_rake_entries(table_id)


@router.post("/tables/{table_id}/rake-entries", response_model=CashRakeEntryResponse)
def add_rake_entry(
    table_id: str,
    data: CashRakeEntryCreate,
    user=_mesas,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Apuração PARCIAL: o sangeur conta a caixa no meio da noite. Não mexe no
    saldo do caixa — o rake sai do pote, em fichas, e já está na gaveta."""
    try:
        return CashTableService.add_rake_entry(
            table_id, data, user.get("sub"), "partial", organization_id
        )
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Assentos e sessões de jogador
# ══════════════════════════════════════════════════════════════════════

@router.post("/tables/{table_id}/seats/{seat_number}/sit", response_model=SitPlayerResult)
def sit_player(
    table_id: str,
    seat_number: int,
    data: SitPlayer,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Senta o jogador e vende as fichas num passo só — sentar sem pagar
    deixaria uma cadeira ocupada por alguém sem fichas, estado que não existe
    na mesa real."""
    try:
        return CashTransactionService.sit(
            table_id, seat_number, data, user.get("sub"), organization_id
        )
    except ValueError as e:
        raise da_excecao(e)


@router.get("/player-sessions", response_model=List[CashPlayerSessionResponse])
def list_player_sessions(
    cash_day_id: Optional[str] = None,
    table_id: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(get_current_user),
):
    return CashTransactionService.list_player_sessions(cash_day_id, table_id, status)


@router.get("/player-sessions/{player_session_id}", response_model=CashPlayerSessionResponse)
def get_player_session(player_session_id: str, user=Depends(get_current_user)):
    try:
        return CashTransactionService.get_player_session(player_session_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/player-sessions/{player_session_id}/rebuy", response_model=CashTransactionResponse)
def rebuy(
    player_session_id: str,
    data: CashRebuy,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    try:
        return CashTransactionService.rebuy(
            player_session_id, data, user.get("sub"), organization_id
        )
    except ValueError as e:
        raise da_excecao(e)


@router.post("/player-sessions/{player_session_id}/stand", response_model=CashPlayerSessionResponse)
def stand(
    player_session_id: str,
    data: StandPlayer,
    user=_operar,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    """Levanta o jogador, paga o cash-out e libera a cadeira. Valor zero é
    válido: quem perdeu tudo levanta do mesmo jeito."""
    try:
        return CashTransactionService.stand(
            player_session_id, data, user.get("sub"), organization_id
        )
    except ValueError as e:
        raise da_excecao(e)


# ══════════════════════════════════════════════════════════════════════
# Dinheiro
# ══════════════════════════════════════════════════════════════════════

@router.get("/transactions", response_model=List[CashTransactionResponse])
def list_transactions(
    cash_day_id: Optional[str] = None,
    table_id: Optional[str] = None,
    player_id: Optional[str] = None,
    player_session_id: Optional[str] = None,
    type: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    user=Depends(get_current_user),
):
    return CashTransactionService.list_transactions(
        cash_day_id, table_id, player_id, player_session_id, type, limit
    )


@router.post("/transactions/{transaction_id}/cancel", response_model=CashTransactionResponse)
def cancel_transaction(transaction_id: str, data: CashTransactionCancel, user=_admin):
    """Estorno lógico e retomável — nunca DELETE. O motivo é obrigatório: é ele
    que explica a diferença no fechamento do caixa."""
    try:
        return CashTransactionService.cancel(transaction_id, data.reason, user.get("sub"))
    except ValueError as e:
        raise da_excecao(e)
