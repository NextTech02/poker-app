"""Rotas do FIADO DA CASA (`/house-credit`).

Sem `require_module` único, de propósito: a conta do jogador é UMA para o
clube inteiro — a dívida nasce no cash, mas é recebida também no bar. Quem
barra é a permissão de cada rota; o isolamento entre clubes é o RLS (leitura
e recebimento vão como o usuário) e a organização do JWT (gestão).

O `X-Stage-ID` que o navegador manda em toda chamada é ignorado aqui: fiado
não é de etapa.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query

from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
from app.dependencies import get_org_id, get_org_id_optional
from app.models.house_credit import (
    HouseCreditAccount,
    HouseCreditAccountUpdate,
    HouseCreditBalance,
    HouseCreditDebtors,
    HouseCreditEntry,
    HouseCreditMovement,
    HouseCreditPaymentCreate,
    HouseCreditReverse,
    HouseCreditSettings,
    HouseCreditSettingsUpdate,
    HouseCreditUnderOffset,
    HouseCreditWriteOff,
)
from app.services.house_credit_service import PERMISSAO_GESTAO, HouseCreditService
from app.utils.erros import da_excecao

router = APIRouter(prefix="/house-credit", tags=["house-credit"])

_gerir = Depends(require_permission(PERMISSAO_GESTAO))
# Recebe quem opera uma gaveta onde o dinheiro pode cair (cash ou bar) — e o
# gerente. A gaveta aberta é exigida pelo serviço e conferida pelo banco.
_receber = Depends(require_permission(
    "cash.operate", "bar.operate", "cashbox.operate", "cashier", PERMISSAO_GESTAO,
))


# ── Configuração ─────────────────────────────────────────────────────────────

@router.get("/settings", response_model=HouseCreditSettings)
def get_settings(
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return HouseCreditService.get_settings(organization_id)


@router.put("/settings", response_model=HouseCreditSettings)
def update_settings(
    data: HouseCreditSettingsUpdate,
    user=_gerir,
    organization_id: str = Depends(get_org_id),
):
    try:
        return HouseCreditService.update_settings(data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


# ── Conta do jogador ─────────────────────────────────────────────────────────

@router.get("/balances", response_model=List[HouseCreditBalance])
def get_balances(
    player_ids: str = Query(..., description="ids separados por vírgula"),
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    ids = [p.strip() for p in player_ids.split(",") if p.strip()][:500]
    return HouseCreditService.balances(ids, organization_id)


@router.get("/debtors", response_model=HouseCreditDebtors)
def get_debtors(
    user=_gerir,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return HouseCreditService.debtors(organization_id)


@router.get("/under-offsets", response_model=List[HouseCreditUnderOffset])
def get_under_offsets(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    user=_gerir,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return HouseCreditService.under_offsets(organization_id, date_from, date_to, limit)


@router.get("/players/{player_id}", response_model=HouseCreditAccount)
def get_account(
    player_id: str,
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return HouseCreditService.get_account(player_id, organization_id)


@router.put("/players/{player_id}", response_model=HouseCreditAccount)
def upsert_account(
    player_id: str,
    data: HouseCreditAccountUpdate,
    user=_gerir,
    organization_id: str = Depends(get_org_id),
):
    try:
        return HouseCreditService.upsert_account(player_id, data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.get("/players/{player_id}/entries", response_model=List[HouseCreditEntry])
def get_entries(
    player_id: str,
    limit: int = Query(200, ge=1, le=1000),
    user=Depends(get_current_user),
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    return HouseCreditService.entries(player_id, organization_id, limit)


# ── Movimentos ───────────────────────────────────────────────────────────────

@router.post("/players/{player_id}/payments", response_model=HouseCreditMovement)
def receive_payment(
    player_id: str,
    data: HouseCreditPaymentCreate,
    user=_receber,
    organization_id: Optional[str] = Depends(get_org_id_optional),
):
    try:
        return HouseCreditService.receive_payment(player_id, data, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)


@router.post("/players/{player_id}/write-offs", response_model=HouseCreditMovement)
def write_off(
    player_id: str,
    data: HouseCreditWriteOff,
    user=_gerir,
    organization_id: str = Depends(get_org_id),
):
    try:
        return HouseCreditService.write_off(
            player_id, data.amount, data.reason, user.get("sub"), organization_id
        )
    except ValueError as e:
        raise da_excecao(e)


@router.post("/entries/{entry_id}/reverse", response_model=HouseCreditMovement)
def reverse_payment(
    entry_id: str,
    data: HouseCreditReverse,
    user=_gerir,
    organization_id: str = Depends(get_org_id),
):
    try:
        return HouseCreditService.reverse_payment(entry_id, data.reason, user.get("sub"), organization_id)
    except ValueError as e:
        raise da_excecao(e)
