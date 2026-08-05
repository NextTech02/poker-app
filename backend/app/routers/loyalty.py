from fastapi import APIRouter, Depends, HTTPException
from app.auth.jwt import get_current_user
from app.models.loyalty import (
    LoyaltySettingsUpdate, RewardCreate, RewardUpdate, RedeemRequest,
    CouponRedeem, CouponCreate, GoalCreate, GiftRequest,
)
from app.services.loyalty_service import LoyaltyService

router = APIRouter(prefix="/loyalty", tags=["loyalty"])


def _org(current_user: dict):
    return current_user.get("organization_id")


@router.get("/config")
def get_config(current_user: dict = Depends(get_current_user)):
    """Config do programa de fidelidade da org + níveis VIP."""
    return LoyaltyService.get_config(_org(current_user))


@router.patch("/config")
def update_config(data: LoyaltySettingsUpdate, current_user: dict = Depends(get_current_user)):
    """Atualiza as configurações (habilitar, pontos por moeda, cashback, o que pontua)."""
    updated = LoyaltyService.update_settings(_org(current_user), data.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Configuração de fidelidade não encontrada.")
    return updated


@router.get("/players/{player_id}")
def get_player_loyalty(player_id: str, current_user: dict = Depends(get_current_user)):
    """Pontos, cashback, tier, próximo tier, extrato e recompensas disponíveis."""
    return LoyaltyService.get_player_loyalty(_org(current_user), player_id)


# ── Recompensas (catálogo) ──────────────────────────────────────────────────

@router.get("/rewards")
def list_rewards(active: bool = False, current_user: dict = Depends(get_current_user)):
    return LoyaltyService.get_rewards(_org(current_user), active_only=active)


@router.post("/rewards")
def create_reward(data: RewardCreate, current_user: dict = Depends(get_current_user)):
    return LoyaltyService.create_reward(_org(current_user), data.model_dump())


@router.patch("/rewards/{reward_id}")
def update_reward(reward_id: str, data: RewardUpdate, current_user: dict = Depends(get_current_user)):
    updated = LoyaltyService.update_reward(_org(current_user), reward_id, data.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="Recompensa não encontrada.")
    return updated


@router.delete("/rewards/{reward_id}")
def delete_reward(reward_id: str, current_user: dict = Depends(get_current_user)):
    ok = LoyaltyService.delete_reward(_org(current_user), reward_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Recompensa não encontrada.")
    return {"deleted": True}


# ── Resgate / cashback ──────────────────────────────────────────────────────

@router.post("/players/{player_id}/redeem")
def redeem(player_id: str, data: RedeemRequest, current_user: dict = Depends(get_current_user)):
    """Resgata uma recompensa: deduz pontos e cria crédito no caixa do jogador."""
    try:
        return LoyaltyService.redeem_reward(_org(current_user), player_id, data.reward_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/players/{player_id}/convert-cashback")
def convert_cashback(player_id: str, current_user: dict = Depends(get_current_user)):
    """Converte o saldo de cashback do jogador em crédito no caixa."""
    try:
        return LoyaltyService.convert_cashback(_org(current_user), player_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Cupons ──────────────────────────────────────────────────────────────────

@router.get("/coupons")
def list_coupons(current_user: dict = Depends(get_current_user)):
    return LoyaltyService.get_coupons(_org(current_user))


@router.post("/coupons")
def create_coupon(data: CouponCreate, current_user: dict = Depends(get_current_user)):
    return LoyaltyService.create_coupon(_org(current_user), data.model_dump())


@router.delete("/coupons/{coupon_id}")
def delete_coupon(coupon_id: str, current_user: dict = Depends(get_current_user)):
    if not LoyaltyService.delete_coupon(_org(current_user), coupon_id):
        raise HTTPException(status_code=404, detail="Cupom não encontrado.")
    return {"deleted": True}


@router.post("/players/{player_id}/coupon")
def redeem_coupon(player_id: str, data: CouponRedeem, current_user: dict = Depends(get_current_user)):
    """Resgata um cupom para o jogador (pontos ou crédito)."""
    try:
        return LoyaltyService.redeem_coupon(_org(current_user), player_id, data.code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Metas / desafios ─────────────────────────────────────────────────────────

@router.get("/goals")
def list_goals(current_user: dict = Depends(get_current_user)):
    return LoyaltyService.get_goals(_org(current_user), None)


@router.post("/goals")
def create_goal(data: GoalCreate, current_user: dict = Depends(get_current_user)):
    return LoyaltyService.create_goal(_org(current_user), data.model_dump())


@router.delete("/goals/{goal_id}")
def delete_goal(goal_id: str, current_user: dict = Depends(get_current_user)):
    if not LoyaltyService.delete_goal(_org(current_user), goal_id):
        raise HTTPException(status_code=404, detail="Meta não encontrada.")
    return {"deleted": True}


@router.get("/players/{player_id}/goals")
def player_goals(player_id: str, current_user: dict = Depends(get_current_user)):
    return LoyaltyService.get_goals(_org(current_user), player_id)


@router.post("/players/{player_id}/goals/{goal_id}/claim")
def claim_goal(player_id: str, goal_id: str, current_user: dict = Depends(get_current_user)):
    """Reivindica a recompensa de uma meta concluída."""
    try:
        return LoyaltyService.claim_goal(_org(current_user), player_id, goal_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ── Presente / indicação (Fase 4) ────────────────────────────────────────────

@router.post("/players/{player_id}/gift")
def gift_credit(player_id: str, data: GiftRequest, current_user: dict = Depends(get_current_user)):
    """Presenteia um crédito não utilizado do jogador a outro (novo) jogador."""
    try:
        return LoyaltyService.gift_credit(_org(current_user), data.credit_id, data.to_player_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
