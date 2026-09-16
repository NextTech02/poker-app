from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.models.player_credit import (
    PlayerCreditCreate,
    PlayerCreditResponse,
    CreditSettlementRequest,
    CreditTransactionResponse,
    PlayerBalanceSummary,
    PlayerStatementEntry,
)
from app.services.transaction_filters import sem_canceladas
from app.utils.erros import ErroDeNegocio


class PlayerCreditService:
    # ================================================
    # Credit Management
    # ================================================

    @staticmethod
    def grant_credit(data: PlayerCreditCreate, user_id: str) -> PlayerCreditResponse:
        """Grant a new credit from a sponsor to a player"""
        # Validate player exists
        player = supabase.table("players").select("id, name, nickname").eq("id", data.player_id).execute()
        if not player.data:
            raise ErroDeNegocio(
                "jogador_nao_encontrado", "Jogador não encontrado", status=404
            )

        # Validate sponsor exists
        sponsor = supabase.table("sponsors").select("id, name").eq("id", data.sponsor_id).execute()
        if not sponsor.data:
            raise ErroDeNegocio(
                "patrocinador_nao_encontrado", "Patrocinador não encontrado", status=404
            )

        # Create credit record
        credit_data = {
            "player_id": data.player_id,
            "sponsor_id": data.sponsor_id,
            "stage_id": data.stage_id,
            "original_amount": data.amount,
            "remaining_amount": data.amount,
            "used_amount": 0,
            "status": "active",
            "prize_deduction_amount": 0,
            "sponsor_owes": 0,
            "notes": data.notes,
            "created_by": user_id,
        }

        response = supabase.table("player_credits").insert(credit_data).execute()
        credit = response.data[0]

        # Create ledger entry
        supabase.table("credit_transactions").insert({
            "credit_id": credit["id"],
            "player_id": data.player_id,
            "type": "credit_granted",
            "amount": data.amount,
            "balance_after": data.amount,
            "notes": data.notes,
            "created_by": user_id,
        }).execute()

        return PlayerCreditService._enrich_credit(credit, player.data[0], sponsor.data[0])

    @staticmethod
    def get_player_credits(
        player_id: str,
        status: Optional[str] = None,
        stage_id: Optional[str] = None,
    ) -> List[PlayerCreditResponse]:
        """Get all credits for a player"""
        query = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("player_id", player_id)

        if status:
            query = query.eq("status", status)
        if stage_id:
            # Credits scoped to this stage OR unscoped credits
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.order("created_at", desc=True).execute()

        results = []
        for item in response.data or []:
            p = item.pop("players", {}) or {}
            s = item.pop("sponsors", {}) or {}
            results.append(PlayerCreditService._enrich_credit(item, p, s))
        return results

    @staticmethod
    def get_player_available_credit(player_id: str, stage_id: Optional[str] = None) -> float:
        """Get total available credit for a player"""
        query = supabase.table("player_credits").select("remaining_amount")\
            .eq("player_id", player_id)\
            .eq("status", "active")

        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.execute()
        return sum(float(c["remaining_amount"]) for c in (response.data or []))

    @staticmethod
    def get_credit(credit_id: str) -> Optional[PlayerCreditResponse]:
        """Get a single credit with details"""
        response = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("id", credit_id).execute()

        if not response.data:
            return None

        item = response.data[0]
        p = item.pop("players", {}) or {}
        s = item.pop("sponsors", {}) or {}
        return PlayerCreditService._enrich_credit(item, p, s)

    @staticmethod
    def get_credit_transactions(credit_id: str) -> List[CreditTransactionResponse]:
        """Get all transactions for a specific credit"""
        rows = (
            supabase.table("credit_transactions").select("*")
            .eq("credit_id", credit_id)
            .order("created_at", desc=True)
            .execute()
            .data
            or []
        )
        if not rows:
            return []

        # The sponsor is fixed for this credit — look it up ONCE instead of once
        # per transaction row (was N identical queries).
        sponsor_name = None
        credit = supabase.table("player_credits").select("sponsors(name)").eq("id", credit_id).execute()
        if credit.data:
            s = credit.data[0].get("sponsors", {}) or {}
            sponsor_name = s.get("name")

        # Resolve all tournament names in ONE query, then map in memory.
        tournament_ids = list({r["tournament_id"] for r in rows if r.get("tournament_id")})
        name_by_tournament = {}
        if tournament_ids:
            t_rows = (
                supabase.table("tournaments").select("id, name")
                .in_("id", tournament_ids)
                .execute()
                .data
                or []
            )
            name_by_tournament = {t["id"]: t["name"] for t in t_rows}

        return [
            CreditTransactionResponse(
                **item,
                tournament_name=name_by_tournament.get(item.get("tournament_id")),
                sponsor_name=sponsor_name,
            )
            for item in rows
        ]

    # ================================================
    # Credit Usage (buy-in/rebuy/addon)
    # ================================================

    @staticmethod
    def use_credit(
        player_id: str,
        amount: float,
        tournament_id: Optional[str],
        tournament_day_id: Optional[str],
        entry_type: str,
        user_id: str,
        stage_id: Optional[str] = None,
        bar_payment_id: Optional[str] = None,
    ) -> dict:
        """
        Consume credit for a buy-in/rebuy/addon — ou para uma perna de
        pagamento do BAR (`entry_type='bar'`, sem torneio; `bar_payment_id`
        amarra o lançamento à perna, para um estorno futuro achá-lo).
        Uses FIFO: oldest active credits first.
        Returns {'credit_used': X, 'cash_remaining': Y}
        """
        # Get active credits ordered by creation date (FIFO)
        query = supabase.table("player_credits").select("*")\
            .eq("player_id", player_id)\
            .eq("status", "active")\
            .gt("remaining_amount", 0)\
            .order("created_at")

        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.execute()
        credits = response.data or []

        total_available = sum(float(c["remaining_amount"]) for c in credits)
        if total_available <= 0:
            # Regra, não "não encontrado": o jogador existe, o saldo é que acabou.
            raise ErroDeNegocio(
                "sem_credito_disponivel", "Jogador não possui crédito disponível"
            )

        credit_to_use = min(amount, total_available)
        remaining_to_deduct = credit_to_use

        type_map = {
            "buy_in": "credit_used_buyin",
            "rebuy": "credit_used_rebuy",
            "addon": "credit_used_addon",
            "bar": "credit_used_bar",
        }
        tx_type = type_map.get(entry_type, "credit_used_buyin")

        for credit in credits:
            if remaining_to_deduct <= 0:
                break

            available = float(credit["remaining_amount"])
            deduct = min(available, remaining_to_deduct)
            new_remaining = available - deduct
            new_used = float(credit["used_amount"]) + deduct
            new_sponsor_owes = new_used - float(credit["prize_deduction_amount"])

            new_status = "active" if new_remaining > 0 else "fully_used"

            supabase.table("player_credits").update({
                "remaining_amount": new_remaining,
                "used_amount": new_used,
                "sponsor_owes": new_sponsor_owes,
                "status": new_status,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", credit["id"]).execute()

            lancamento = {
                "credit_id": credit["id"],
                "player_id": player_id,
                "tournament_id": tournament_id,
                "tournament_day_id": tournament_day_id,
                "type": tx_type,
                "amount": deduct,
                "balance_after": new_remaining,
                "created_by": user_id,
            }
            if bar_payment_id:
                lancamento["bar_payment_id"] = bar_payment_id
            supabase.table("credit_transactions").insert(lancamento).execute()

            remaining_to_deduct -= deduct

        cash_remaining = amount - credit_to_use
        return {
            "credit_used": credit_to_use,
            "cash_remaining": cash_remaining,
        }

    # ================================================
    # Prize Deduction
    # ================================================

    @staticmethod
    def deduct_from_prize(player_id: str, prize_amount: float, tournament_id: str, user_id: str) -> dict:
        """
        Deduct outstanding credits from a prize payout.
        Returns breakdown of original prize, deduction, and net payout.
        """
        # Find credits with outstanding usage (used > prize_deduction)
        response = supabase.table("player_credits").select("*")\
            .eq("player_id", player_id)\
            .in_("status", ["active", "fully_used"])\
            .order("created_at")\
            .execute()

        total_deduction = 0
        for credit in (response.data or []):
            outstanding = float(credit["used_amount"]) - float(credit["prize_deduction_amount"])
            if outstanding <= 0:
                continue

            deduct = min(outstanding, prize_amount - total_deduction)
            if deduct <= 0:
                break

            new_prize_deduction = float(credit["prize_deduction_amount"]) + deduct
            new_sponsor_owes = float(credit["used_amount"]) - new_prize_deduction

            update_data = {
                "prize_deduction_amount": new_prize_deduction,
                "sponsor_owes": max(0, new_sponsor_owes),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }

            # If fully recovered, mark as settled
            if new_sponsor_owes <= 0 and float(credit["remaining_amount"]) <= 0:
                update_data["status"] = "settled_by_prize"
                update_data["settled_at"] = datetime.now(timezone.utc).isoformat()

            supabase.table("player_credits").update(update_data)\
                .eq("id", credit["id"]).execute()

            supabase.table("credit_transactions").insert({
                "credit_id": credit["id"],
                "player_id": player_id,
                "tournament_id": tournament_id,
                "type": "prize_deduction",
                "amount": deduct,
                "balance_after": float(credit["remaining_amount"]),
                "created_by": user_id,
                "notes": f"Desconto automático da premiação",
            }).execute()

            total_deduction += deduct

        return {
            "original_prize": prize_amount,
            "deducted_amount": total_deduction,
            "net_prize_payout": prize_amount - total_deduction,
        }

    # ================================================
    # Settlement & Cancellation
    # ================================================

    @staticmethod
    def settle_sponsor_payment(credit_id: str, data: CreditSettlementRequest, user_id: str) -> PlayerCreditResponse:
        """Record sponsor payment for outstanding credit"""
        credit_resp = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("id", credit_id).execute()

        if not credit_resp.data:
            raise ErroDeNegocio(
                "credito_nao_encontrado", "Crédito não encontrado", status=404
            )

        credit = credit_resp.data[0]
        p = credit.pop("players", {}) or {}
        s = credit.pop("sponsors", {}) or {}

        supabase.table("player_credits").update({
            "sponsor_owes": max(0, float(credit["sponsor_owes"]) - data.amount),
            "status": "settled_by_sponsor",
            "settled_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", credit_id).execute()

        supabase.table("credit_transactions").insert({
            "credit_id": credit_id,
            "player_id": credit["player_id"],
            "type": "sponsor_payment",
            "amount": data.amount,
            "balance_after": float(credit["remaining_amount"]),
            "notes": data.notes,
            "created_by": user_id,
        }).execute()

        updated = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("id", credit_id).execute()
        item = updated.data[0]
        p2 = item.pop("players", {}) or {}
        s2 = item.pop("sponsors", {}) or {}
        return PlayerCreditService._enrich_credit(item, p2, s2)

    @staticmethod
    def cancel_credit(credit_id: str, user_id: str) -> PlayerCreditResponse:
        """Cancel an unused credit"""
        credit_resp = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("id", credit_id).execute()

        if not credit_resp.data:
            raise ErroDeNegocio(
                "credito_nao_encontrado", "Crédito não encontrado", status=404
            )

        credit = credit_resp.data[0]
        if float(credit["used_amount"]) > 0:
            raise ErroDeNegocio(
                "credito_ja_utilizado",
                "Não é possível cancelar um crédito já utilizado",
                status=409,
            )

        p = credit.pop("players", {}) or {}
        s = credit.pop("sponsors", {}) or {}

        supabase.table("player_credits").update({
            "status": "cancelled",
            "remaining_amount": 0,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", credit_id).execute()

        supabase.table("credit_transactions").insert({
            "credit_id": credit_id,
            "player_id": credit["player_id"],
            "type": "credit_cancelled",
            "amount": float(credit["original_amount"]),
            "balance_after": 0,
            "created_by": user_id,
        }).execute()

        updated = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        ).eq("id", credit_id).execute()
        item = updated.data[0]
        p2 = item.pop("players", {}) or {}
        s2 = item.pop("sponsors", {}) or {}
        return PlayerCreditService._enrich_credit(item, p2, s2)

    # ================================================
    # Player Statement & Balance
    # ================================================

    @staticmethod
    def get_player_statement(
        player_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        category: Optional[str] = None,
        type_filter: Optional[str] = None,
        tournament_id: Optional[str] = None,
    ) -> List[PlayerStatementEntry]:
        """Get unified financial statement for a player"""
        entries = []

        # 1. Regular transactions (buy_in, rebuy, addon, prize)
        if category is None or category == "transaction":
            query = supabase.table("transactions").select(
                "*, tournaments(name)"
            ).eq("player_id", player_id)

            if date_from:
                query = query.gte("created_at", date_from)
            if date_to:
                query = query.lte("created_at", date_to)
            if type_filter and type_filter in ("buy_in", "rebuy", "addon", "prize"):
                query = query.eq("type", type_filter)
            if tournament_id:
                query = query.eq("tournament_id", tournament_id)

            tx_response = query.order("created_at", desc=True).execute()

            # Venda cancelada não entra no extrato financeiro do jogador: ela
            # foi estornada, e mostrá-la faria o total gasto dele não bater.
            for tx in sem_canceladas(tx_response.data or []):
                t = tx.pop("tournaments", {}) or {}
                entries.append(PlayerStatementEntry(
                    id=tx["id"],
                    date=tx["created_at"],
                    category="transaction",
                    type=tx["type"],
                    amount=float(tx["amount"]),
                    tournament_name=t.get("name"),
                    payment_source=tx.get("payment_source", "cash"),
                    notes=tx.get("notes"),
                ))

        # 2. Credit transactions
        if category is None or category == "credit":
            query = supabase.table("credit_transactions").select(
                "*, player_credits(sponsors(name)), tournaments(name), tournament_days(day_name)"
            ).eq("player_id", player_id)

            if date_from:
                query = query.gte("created_at", date_from)
            if date_to:
                query = query.lte("created_at", date_to)
            if type_filter and type_filter.startswith("credit_"):
                query = query.eq("type", type_filter)
            if tournament_id:
                query = query.eq("tournament_id", tournament_id)

            ct_response = query.order("created_at", desc=True).execute()

            for ct in (ct_response.data or []):
                pc = ct.pop("player_credits", {}) or {}
                sp = pc.get("sponsors", {}) or {}
                t = ct.pop("tournaments", {}) or {}
                td = ct.pop("tournament_days", {}) or {}
                entries.append(PlayerStatementEntry(
                    id=ct["id"],
                    date=ct["created_at"],
                    category="credit",
                    type=ct["type"],
                    amount=float(ct["amount"]),
                    tournament_name=t.get("name"),
                    tournament_day_name=td.get("day_name"),
                    sponsor_name=sp.get("name"),
                    notes=ct.get("notes"),
                ))

        # Sort all entries by date descending
        entries.sort(key=lambda e: e.date, reverse=True)
        return entries

    @staticmethod
    def get_player_balance_summary(player_id: str) -> PlayerBalanceSummary:
        """Get aggregated balance summary for a player"""
        # Get player name
        player = supabase.table("players").select("name").eq("id", player_id).execute()
        player_name = player.data[0]["name"] if player.data else None

        # Get all credits
        credits_response = supabase.table("player_credits").select(
            "original_amount, remaining_amount, used_amount, prize_deduction_amount, sponsor_owes, status"
        ).eq("player_id", player_id).neq("status", "cancelled").execute()

        credits = credits_response.data or []

        total_received = sum(float(c["original_amount"]) for c in credits)
        total_used = sum(float(c["used_amount"]) for c in credits)
        total_remaining = sum(float(c["remaining_amount"]) for c in credits)
        total_deductions = sum(float(c["prize_deduction_amount"]) for c in credits)
        total_owes = sum(float(c["sponsor_owes"]) for c in credits)

        return PlayerBalanceSummary(
            player_id=player_id,
            player_name=player_name,
            total_credits_received=total_received,
            total_credits_used=total_used,
            total_credits_remaining=total_remaining,
            total_prize_deductions=total_deductions,
            total_sponsor_owes=total_owes,
        )

    # ================================================
    # Admin Views
    # ================================================

    @staticmethod
    def get_all_credits(
        status: Optional[str] = None,
        stage_id: Optional[str] = None,
        sponsor_id: Optional[str] = None,
    ) -> List[PlayerCreditResponse]:
        """Get all credits with optional filters (admin view)"""
        query = supabase.table("player_credits").select(
            "*, players(name, nickname), sponsors(name)"
        )

        if status:
            query = query.eq("status", status)
        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
        if sponsor_id:
            query = query.eq("sponsor_id", sponsor_id)

        response = query.order("created_at", desc=True).execute()

        results = []
        for item in response.data or []:
            p = item.pop("players", {}) or {}
            s = item.pop("sponsors", {}) or {}
            results.append(PlayerCreditService._enrich_credit(item, p, s))
        return results

    # ================================================
    # Helpers
    # ================================================

    @staticmethod
    def _enrich_credit(credit: dict, player: dict, sponsor: dict) -> PlayerCreditResponse:
        return PlayerCreditResponse(
            **credit,
            player_name=player.get("name"),
            player_nickname=player.get("nickname"),
            sponsor_name=sponsor.get("name"),
        )
