from fastapi import APIRouter, Depends, Query
from typing import List, Optional
from app.models.cashbox import (
    CashboxResponse,
    CashboxCreate,
    CashboxOpen,
    CashboxClose,
    CashboxSupply,
    CashboxSangria,
    CashboxSessionResponse,
    CashboxTransactionResponse,
    CashboxSummary,
    CashboxAggregatedSummary,
    CashboxDemonstrativo,
)
from app.services.cashbox_service import CashboxService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional
from app.utils.erros import da_excecao, nao_encontrado, recusado, sem_permissao

router = APIRouter(prefix="/cashboxes", tags=["cashboxes"])


def _auth_user_id(user: dict) -> str:
    return user.get("sub") or user.get("id")


# ── Read ──

@router.get("", response_model=List[CashboxResponse])
def list_cashboxes(
    status: Optional[str] = Query(None),
    cash_day_id: Optional[str] = Query(None),
    bar_shift_id: Optional[str] = Query(None),
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    """Âncora explícita na query (dia de cash, turno do bar) vence a etapa do
    header: a etapa selecionada por acaso não pode esconder as gavetas do
    turno."""
    return CashboxService.list_cashboxes(
        _auth_user_id(user), stage_id=stage_id, status=status,
        cash_day_id=cash_day_id, bar_shift_id=bar_shift_id,
    )


@router.post("", response_model=CashboxResponse)
def create_cashbox(
    data: CashboxCreate,
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    if not CashboxService.can_admin(_auth_user_id(user)):
        raise sem_permissao("sem_permissao_criar_caixa", "Sem permissão para criar caixas")
    try:
        return CashboxService.create_for_staff(
            data.staff_id, stage_id,
            cash_day_id=data.cash_day_id, bar_shift_id=data.bar_shift_id,
        )
    except ValueError as exc:
        # `da_excecao` respeita o status que a regra escolheu (funcionário
        # inexistente é 404, não 400); o 400 fica só como padrão.
        raise da_excecao(exc)


@router.get("/me/current", response_model=Optional[CashboxResponse])
def get_my_current(
    cash_day_id: Optional[str] = Query(None),
    bar_shift_id: Optional[str] = Query(None),
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    """A gaveta do operador na âncora atual.

    No torneio a âncora vem do header X-Stage-ID; no cash game e no bar ela
    vem EXPLÍCITA na query, porque esses módulos não têm etapa — a operação é
    por dia/turno, que viaja na URL em vez de num segundo header mágico.
    """
    if bar_shift_id:
        return CashboxService.get_my_current(
            _auth_user_id(user), bar_shift_id=bar_shift_id
        )
    if cash_day_id:
        return CashboxService.get_my_current(
            _auth_user_id(user), cash_day_id=cash_day_id
        )
    if not stage_id:
        raise recusado("etapa_nao_selecionada", "Selecione uma etapa")
    return CashboxService.get_my_current(_auth_user_id(user), stage_id=stage_id)


@router.get("/aggregated", response_model=CashboxAggregatedSummary)
def get_aggregated_summary(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    if not CashboxService.can_admin(_auth_user_id(user)):
        raise sem_permissao(
            "sem_permissao_ver_consolidado", "Sem permissão para ver o consolidado dos caixas"
        )
    return CashboxService.get_aggregated_summary(stage_id=stage_id, date_from=date_from, date_to=date_to)


@router.get("/demonstrativo", response_model=CashboxDemonstrativo)
def get_demonstrativo(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    staff_id: Optional[str] = Query(None),
    cash_day_id: Optional[str] = Query(None),
    bar_shift_id: Optional[str] = Query(None),
    stage_id: str = Depends(get_stage_id_optional),
    user=Depends(get_current_user),
):
    if not CashboxService.can_admin(_auth_user_id(user)):
        raise sem_permissao(
            "sem_permissao_ver_demonstrativo",
            "Sem permissão para ver o demonstrativo dos caixas",
        )
    return CashboxService.get_demonstrativo(
        stage_id=stage_id, date_from=date_from, date_to=date_to, staff_id=staff_id,
        cash_day_id=cash_day_id, bar_shift_id=bar_shift_id,
    )


@router.get("/{cashbox_id}", response_model=CashboxResponse)
def get_cashbox(cashbox_id: str, user=Depends(get_current_user)):
    cb = CashboxService.get_cashbox(cashbox_id)
    if not cb:
        raise nao_encontrado("caixa_nao_encontrado", "Caixa não encontrado")
    return cb


@router.get("/{cashbox_id}/sessions", response_model=List[CashboxSessionResponse])
def list_sessions(cashbox_id: str, user=Depends(get_current_user)):
    return CashboxService.list_sessions(cashbox_id)


@router.get("/{cashbox_id}/transactions", response_model=List[CashboxTransactionResponse])
def list_transactions(
    cashbox_id: str,
    session_id: Optional[str] = Query(None),
    user=Depends(get_current_user),
):
    return CashboxService.list_transactions(cashbox_id, session_id=session_id)


@router.get("/{cashbox_id}/summary", response_model=CashboxSummary)
def get_summary(
    cashbox_id: str,
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    user=Depends(get_current_user),
):
    try:
        return CashboxService.get_summary(cashbox_id, date_from=date_from, date_to=date_to)
    except ValueError as exc:
        # 404 é o padrão aqui porque a única recusa deste caminho é "caixa não
        # existe"; um `ErroDeNegocio` com status próprio continua mandando.
        raise da_excecao(exc, status=404)


# ── Sessions ──

@router.post("/{cashbox_id}/open", response_model=CashboxSessionResponse)
def open_cashbox(cashbox_id: str, data: CashboxOpen, user=Depends(get_current_user)):
    try:
        return CashboxService.open_session(
            cashbox_id,
            _auth_user_id(user),
            data.initial_balance,
            data.notes,
        )
    except ValueError as exc:
        raise da_excecao(exc)


@router.post("/{cashbox_id}/close", response_model=CashboxSessionResponse)
def close_cashbox(cashbox_id: str, data: CashboxClose, user=Depends(get_current_user)):
    try:
        return CashboxService.close_session(
            cashbox_id,
            _auth_user_id(user),
            data.actual_final_balance,
            data.notes,
        )
    except ValueError as exc:
        raise da_excecao(exc)


# ── Admin movements ──

@router.post("/{cashbox_id}/supply", response_model=CashboxTransactionResponse)
def register_supply(cashbox_id: str, data: CashboxSupply, user=Depends(get_current_user)):
    try:
        return CashboxService.register_supply(cashbox_id, _auth_user_id(user), data.amount, data.notes)
    except ValueError as exc:
        raise da_excecao(exc)


@router.post("/{cashbox_id}/sangria", response_model=CashboxTransactionResponse)
def register_sangria(cashbox_id: str, data: CashboxSangria, user=Depends(get_current_user)):
    try:
        return CashboxService.register_sangria(cashbox_id, _auth_user_id(user), data.amount, data.notes)
    except ValueError as exc:
        raise da_excecao(exc)
