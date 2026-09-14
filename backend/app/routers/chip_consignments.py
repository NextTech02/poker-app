from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional

from app.models.chip_consignment import (
    ConsignmentRelease,
    ConsignmentReconcile,
    ConsignmentResponse,
    SaleCreate,
    SaleResponse,
)
from app.services.chip_consignment_service import ChipConsignmentService
from app.services.staff_service import StaffService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission
# Sem `get_stage_id_optional`: o escopo do módulo de cash viaja EXPLÍCITO
# (`cash_day_id` na query ou no corpo), nunca num header. Ver o cabeçalho de
# routers/cash_game.py.

router = APIRouter(prefix="/sangi", tags=["sangi"])

# O SANGEUR É PAPEL DO CASH. Ele circula pelas mesas vendendo fichas de uma
# consignação; no torneio a venda acontece no caixa, com o jogador indo até lá.
# A consignação nasceu ancorada em etapa porque na época só existia torneio.

# Permission groups
MANAGE_PERMS = ("cashier", "general_cash", "cashbox.admin", "employees")  # cashier-side ops
SELL_PERMS = ("sangi", "cashier", "general_cash", "employees")            # sales + own view


def _is_manager(auth_user_id: str) -> bool:
    perms = StaffService.get_my_permissions(auth_user_id)
    if perms.is_admin:
        return True
    return bool(set(MANAGE_PERMS) & set(perms.permissions or []))


# ── Sangi self view + sales (restricted role allowed) ──

@router.get("/me", response_model=Optional[ConsignmentResponse])
def my_open_consignment(
    current_user: dict = Depends(require_permission(*SELL_PERMS)),
    cash_day_id: Optional[str] = None,
):
    """A consignação aberta da sangeur logada, se houver."""
    return ChipConsignmentService.get_my_open(current_user.get("sub"), cash_day_id)


@router.post("/consignments/{consignment_id}/sales", response_model=SaleResponse, status_code=status.HTTP_201_CREATED)
def register_sale(
    consignment_id: str,
    data: SaleCreate,
    current_user: dict = Depends(require_permission(*SELL_PERMS)),
):
    """Register a chip sale (amount + buyer player). The sangi may only sell on
    their own consignment; managers may register on any."""
    uid = current_user.get("sub")
    restrict = not _is_manager(uid)
    return ChipConsignmentService.register_sale(
        consignment_id, data, sold_by=uid,
        acting_auth_user_id=uid, restrict_to_self=restrict,
    )


# ── Cashier-side management (sangi role is blocked here) ──

@router.post("/consignments", response_model=ConsignmentResponse, status_code=status.HTTP_201_CREATED)
def release_consignment(
    data: ConsignmentRelease,
    current_user: dict = Depends(require_permission(*MANAGE_PERMS)),
    cash_day_id: Optional[str] = None,
):
    """O caixa libera um valor em fichas para a sangeur (abre a consignação)."""
    return ChipConsignmentService.release(data, cash_day_id, opened_by=current_user.get("sub"))


@router.get("/consignments", response_model=List[ConsignmentResponse])
def list_consignments(
    sangi_staff_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    current_user: dict = Depends(require_permission(*MANAGE_PERMS)),
    cash_day_id: Optional[str] = None,
):
    return ChipConsignmentService.list(cash_day_id=cash_day_id, sangi_staff_id=sangi_staff_id,
                                       status_filter=status_filter)


@router.get("/consignments/{consignment_id}", response_model=ConsignmentResponse)
def get_consignment(
    consignment_id: str,
    current_user: dict = Depends(require_permission(*MANAGE_PERMS)),
):
    return ChipConsignmentService.get(consignment_id)


@router.post("/consignments/{consignment_id}/reconcile", response_model=ConsignmentResponse)
def reconcile_consignment(
    consignment_id: str,
    data: ConsignmentReconcile,
    current_user: dict = Depends(require_permission(*MANAGE_PERMS)),
):
    """Abate: compare sold vs released, flag divergence, close the consignment."""
    return ChipConsignmentService.reconcile(consignment_id, reconciled_by=current_user.get("sub"), notes=data.notes)


@router.delete("/consignments/{consignment_id}/sales/{sale_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sale(
    consignment_id: str,
    sale_id: str,
    current_user: dict = Depends(require_permission(*MANAGE_PERMS)),
):
    ChipConsignmentService.delete_sale(consignment_id, sale_id)
    return None
