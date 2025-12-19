"""
Cash Register Service
Business logic for cash management: stage cash, general cash, rake, and sangria operations
"""
from typing import Optional, List
from decimal import Decimal
from datetime import datetime
from app.database import supabase
from app.models.cash_register import (
    StageCashRegister,
    GeneralCashRegister,
    RakeRegister,
    SangriaTransaction,
    SangriaTransactionCreate,
    CashDashboard,
    StageCashSummary,
    SangriaResponse
)


class CashRegisterService:
    """Service for managing cash registers and sangria operations"""

    @staticmethod
    def get_stage_cash(stage_id: str) -> Optional[StageCashRegister]:
        """Get stage cash register (caixa do dia) for a specific stage"""
        response = (
            supabase.table("stage_cash_register")
            .select("*")
            .eq("stage_id", stage_id)
            .execute()
        )

        if response.data:
            return StageCashRegister(**response.data[0])
        return None

    @staticmethod
    def get_all_stage_cash() -> List[StageCashSummary]:
        """Get all stage cash registers with stage information"""
        response = (
            supabase.table("stage_cash_register")
            .select("*, stages(id, name, location, status)")
            .order("created_at", desc=True)
            .execute()
        )

        summaries = []
        for item in response.data:
            stage = item.get("stages", {})

            # Remove nested object
            stage_data = {k: v for k, v in item.items() if k != "stages"}

            # Count tournaments in this stage
            tournaments = (
                supabase.table("tournaments")
                .select("id", count="exact")
                .eq("stage_id", item["stage_id"])
                .execute()
            )

            summaries.append(StageCashSummary(
                stage_id=stage.get("id", ""),
                stage_name=stage.get("name", ""),
                stage_location=stage.get("location", ""),
                stage_status=stage.get("status", ""),
                cash_register=StageCashRegister(**stage_data),
                total_tournaments=tournaments.count or 0
            ))

        return summaries

    @staticmethod
    def get_general_cash() -> GeneralCashRegister:
        """Get general cash register (caixa geral)"""
        response = (
            supabase.table("general_cash_register")
            .select("*")
            .limit(1)
            .execute()
        )

        if response.data:
            return GeneralCashRegister(**response.data[0])

        # Create if doesn't exist
        new_register = {
            "current_balance": 0.00,
            "total_received": 0.00
        }
        response = supabase.table("general_cash_register").insert(new_register).execute()
        return GeneralCashRegister(**response.data[0])

    @staticmethod
    def get_rake_register() -> RakeRegister:
        """Get rake register (registro de rake)"""
        response = (
            supabase.table("rake_register")
            .select("*")
            .limit(1)
            .execute()
        )

        if response.data:
            return RakeRegister(**response.data[0])

        # Create if doesn't exist
        new_register = {
            "total_rake": 0.00
        }
        response = supabase.table("rake_register").insert(new_register).execute()
        return RakeRegister(**response.data[0])

    @staticmethod
    def get_sangria_history(stage_id: Optional[str] = None, limit: int = 50) -> List[SangriaTransaction]:
        """Get sangria transaction history"""
        query = supabase.table("sangria_transactions").select("*")

        if stage_id:
            query = query.eq("stage_id", stage_id)

        response = query.order("created_at", desc=True).limit(limit).execute()

        return [SangriaTransaction(**item) for item in response.data]

    @staticmethod
    def perform_sangria(
        sangria_data: SangriaTransactionCreate,
        user_id: str
    ) -> SangriaResponse:
        """
        Perform sangria operation:
        1. Calculate rake (default 20%)
        2. Deduct from stage cash
        3. Add net amount to general cash
        4. Add rake to rake register
        5. Record transaction
        """

        # Get stage cash register
        stage_cash = CashRegisterService.get_stage_cash(sangria_data.stage_id)
        if not stage_cash:
            raise ValueError(f"Cash register not found for stage {sangria_data.stage_id}")

        # Validate sufficient balance
        if stage_cash.current_balance < sangria_data.amount:
            raise ValueError(
                f"Insufficient balance. Available: {stage_cash.current_balance}, "
                f"Requested: {sangria_data.amount}"
            )

        # Calculate rake and net amount
        rake_percentage = sangria_data.rake_percentage
        rake_amount = (sangria_data.amount * rake_percentage / Decimal('100')).quantize(Decimal('0.01'))
        net_amount = sangria_data.amount - rake_amount

        # Start transaction-like operations
        try:
            # 1. Update stage cash (subtract amount)
            new_stage_balance = stage_cash.current_balance - sangria_data.amount
            new_stage_sangrias = stage_cash.total_sangrias + sangria_data.amount

            supabase.table("stage_cash_register").update({
                "current_balance": str(new_stage_balance),
                "total_sangrias": str(new_stage_sangrias),
                "updated_at": datetime.utcnow().isoformat()
            }).eq("stage_id", sangria_data.stage_id).execute()

            # 2. Update general cash (add net amount)
            general_cash = CashRegisterService.get_general_cash()
            new_general_balance = general_cash.current_balance + net_amount
            new_general_total = general_cash.total_received + net_amount

            supabase.table("general_cash_register").update({
                "current_balance": str(new_general_balance),
                "total_received": str(new_general_total),
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", general_cash.id).execute()

            # 3. Update rake register (add rake amount)
            rake_register = CashRegisterService.get_rake_register()
            new_rake_total = rake_register.total_rake + rake_amount

            supabase.table("rake_register").update({
                "total_rake": str(new_rake_total),
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", rake_register.id).execute()

            # 4. Create sangria transaction record
            sangria_record = {
                "stage_id": sangria_data.stage_id,
                "stage_name": sangria_data.stage_name,
                "amount": str(sangria_data.amount),
                "rake_percentage": str(rake_percentage),
                "rake_amount": str(rake_amount),
                "net_amount": str(net_amount),
                "notes": sangria_data.notes,
                "created_by": user_id
            }

            response = supabase.table("sangria_transactions").insert(sangria_record).execute()
            sangria_transaction = SangriaTransaction(**response.data[0])

            # 5. Get updated registers
            updated_stage_cash = CashRegisterService.get_stage_cash(sangria_data.stage_id)
            updated_general_cash = CashRegisterService.get_general_cash()
            updated_rake = CashRegisterService.get_rake_register()

            return SangriaResponse(
                success=True,
                message=f"Sangria realizada com sucesso! Valor líquido: {net_amount}, Rake: {rake_amount}",
                sangria_transaction=sangria_transaction,
                updated_stage_cash=updated_stage_cash,
                updated_general_cash=updated_general_cash,
                updated_rake=updated_rake
            )

        except Exception as e:
            raise Exception(f"Error performing sangria: {str(e)}")

    @staticmethod
    def get_cash_dashboard(stage_id: Optional[str] = None) -> CashDashboard:
        """Get complete cash management dashboard"""
        stage_cash = None
        if stage_id:
            stage_cash = CashRegisterService.get_stage_cash(stage_id)

        general_cash = CashRegisterService.get_general_cash()
        rake = CashRegisterService.get_rake_register()
        recent_sangrias = CashRegisterService.get_sangria_history(stage_id=stage_id, limit=10)

        return CashDashboard(
            stage_cash=stage_cash,
            general_cash=general_cash,
            rake=rake,
            recent_sangrias=recent_sangrias
        )
