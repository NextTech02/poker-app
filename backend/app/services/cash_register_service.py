"""
Cash Register Service
Business logic for cash management: stage cash, general cash, rake, and sangria operations
"""
from typing import Optional, List
from decimal import Decimal
from datetime import datetime, timezone
from collections import Counter
from app.database import supabase
from app.models.cash_register import (
    StageCashRegister,
    GeneralCashRegister,
    RakeRegister,
    SangriaTransaction,
    SangriaTransactionCreate,
    CashDashboard,
    StageCashSummary,
    StageCashScopedSummary,
    PaymentMethodTotal,
    StagePaymentBreakdown,
    SangriaResponse
)
from app.services.transaction_filters import ler_transacoes_ativas
from app.utils.erros import ErroDeNegocio


# Só ENTRADA vira caixa. Prêmio pago (type='prize') sai do caixa e não pode ser
# somado como se fosse dinheiro que entrou.
ENTRY_TYPES = ["buy_in", "rebuy", "addon"]


def _dec(valor) -> Decimal:
    """Converte para Decimal tolerando None/''/número vindo do PostgREST."""
    if valor in (None, ""):
        return Decimal("0")
    return Decimal(str(valor))


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
    def get_stage_pending_rake(stage_id: str) -> Decimal:
        """
        Rake ainda 'devido' no caixa da etapa (Fase 2 dos tipos de buy):
        soma do rake das ENTRADAS (transactions.rake_amount dos torneios da etapa)
        menos o rake já extraído em sangrias anteriores (sangria_transactions).
        É esse valor (proporcional ao quanto se sangra) que vira o rake da sangria.

        Agregado no banco (1 round-trip via RPC); fallback ao fetch+soma abaixo.
        """
        try:
            r = supabase.rpc("get_stage_pending_rake", {"p_stage_id": stage_id}).execute()
            data = r.data
            if isinstance(data, list):
                data = data[0] if data else 0
            if isinstance(data, dict):
                data = next(iter(data.values()), 0)
            if data is not None:
                return Decimal(str(data or 0))
        except Exception:
            pass

        tours = supabase.table("tournaments").select("id").eq("stage_id", stage_id).execute()
        tour_ids = [t["id"] for t in (tours.data or [])]

        entry_rake = Decimal("0")
        if tour_ids:
            # Venda cancelada não gera rake: extrair rake dela seria tirar do
            # caixa uma parte de dinheiro que voltou para o jogador.
            linhas = ler_transacoes_ativas(
                lambda cols: (
                    supabase.table("transactions")
                    .select(cols)
                    .in_("tournament_id", tour_ids)
                    .in_("type", ["buy_in", "rebuy", "addon"])
                ),
                "rake_amount",
            )
            for t in linhas:
                entry_rake += Decimal(str(t.get("rake_amount") or 0))

        sang = (
            supabase.table("sangria_transactions")
            .select("rake_amount")
            .eq("stage_id", stage_id)
            .execute()
        )
        sangria_rake = Decimal("0")
        for s in (sang.data or []):
            sangria_rake += Decimal(str(s.get("rake_amount") or 0))

        pending = entry_rake - sangria_rake
        return pending if pending > 0 else Decimal("0")

    @staticmethod
    def _stage_totals_fallback(stage_id: str) -> dict:
        """Soma em Python o que a RPC somaria no banco (etapas antigas / RPC ausente)."""
        sang = (
            supabase.table("sangria_transactions")
            .select("amount, rake_amount, net_amount")
            .eq("stage_id", stage_id)
            .execute()
        )
        sangrias = sang.data or []

        total_sangrias = Decimal("0")
        rake_extracted = Decimal("0")
        net_to_general = Decimal("0")
        for s in sangrias:
            total_sangrias += _dec(s.get("amount"))
            rake_extracted += _dec(s.get("rake_amount"))
            net_to_general += _dec(s.get("net_amount"))

        # transactions não tem stage_id: a etapa vem pelo torneio.
        tours = supabase.table("tournaments").select("id").eq("stage_id", stage_id).execute()
        tour_ids = [t["id"] for t in (tours.data or [])]

        rake_generated = Decimal("0")
        if tour_ids:
            linhas = ler_transacoes_ativas(
                lambda cols: (
                    supabase.table("transactions")
                    .select(cols)
                    .in_("tournament_id", tour_ids)
                    .in_("type", ENTRY_TYPES)
                ),
                "rake_amount",
            )
            for t in linhas:
                rake_generated += _dec(t.get("rake_amount"))

        return {
            "total_sangrias": total_sangrias,
            "sangria_count": len(sangrias),
            "rake_extracted": rake_extracted,
            "net_to_general": net_to_general,
            "rake_generated": rake_generated,
        }

    @staticmethod
    def get_stage_cash_summary(stage_id: str) -> StageCashScopedSummary:
        """
        Fechamento DESTA etapa. O clube confere etapa por etapa, mas o caixa
        geral é um saldo só da organização (despesas, outras receitas e
        pagamentos de funcionários entram nele sem dizer de que etapa vieram).
        Então o que dá para provar por etapa é o quanto ela MANDOU para o caixa
        geral (net_to_general) e o rake que ela gerou/entregou — nunca um
        "saldo do caixa geral da etapa", que não existe no banco.

        Agregado no banco (1 round-trip via RPC); fallback ao fetch+soma.
        """
        totals = None
        try:
            r = supabase.rpc("get_stage_cash_summary", {"p_stage_id": stage_id}).execute()
            data = r.data
            if isinstance(data, list):
                data = data[0] if data else None
            if isinstance(data, dict):
                totals = data
        except Exception:
            totals = None

        if totals is None:
            totals = CashRegisterService._stage_totals_fallback(stage_id)

        rake_generated = _dec(totals.get("rake_generated"))
        rake_extracted = _dec(totals.get("rake_extracted"))
        # Mesma definição de get_stage_pending_rake, derivada dos números que já
        # estão em mãos — chamar o método de novo custaria mais um round-trip
        # para chegar ao mesmo valor.
        pending = rake_generated - rake_extracted
        if pending < 0:
            pending = Decimal("0")

        stage_cash = CashRegisterService.get_stage_cash(stage_id)

        return StageCashScopedSummary(
            stage_id=stage_id,
            current_balance=stage_cash.current_balance if stage_cash else Decimal("0"),
            total_sangrias=_dec(totals.get("total_sangrias")),
            sangria_count=int(totals.get("sangria_count") or 0),
            rake_generated=rake_generated,
            rake_extracted=rake_extracted,
            pending_rake=pending,
            net_to_general=_dec(totals.get("net_to_general")),
        )

    @staticmethod
    def get_stage_totals_by_payment_method(stage_id: str) -> StagePaymentBreakdown:
        """
        Quanto das ENTRADAS da etapa veio de cada método de pagamento.

        O trigger do caixa da etapa soma buy-in/rebuy/addon independente do
        método, então o saldo mistura dinheiro físico com PIX/cartão. Esta
        quebra é o que diz ao operador quanto ele deve realmente achar na
        gaveta antes de sangrar. Método nulo (entrada gravada antes do cadastro
        de métodos) fica num balde próprio: jogá-lo em "dinheiro" inflaria a
        conferência do caixa físico.

        Agregado no banco (1 round-trip via RPC); fallback ao fetch+soma —
        com muitas entradas na etapa, o fallback transfere todas as linhas.
        """
        linhas = None
        try:
            r = supabase.rpc("get_stage_totals_by_payment_method", {"p_stage_id": stage_id}).execute()
            if isinstance(r.data, list):
                linhas = [
                    (row.get("payment_method") or None, _dec(row.get("total")), int(row.get("entries") or 0))
                    for row in r.data
                ]
        except Exception:
            linhas = None

        if linhas is None:
            tours = supabase.table("tournaments").select("id").eq("stage_id", stage_id).execute()
            tour_ids = [t["id"] for t in (tours.data or [])]

            somas: dict = {}
            if tour_ids:
                # A venda cancelada saiu da gaveta junto com o dinheiro
                # devolvido; mantê-la aqui inflaria a conferência por método.
                linhas = ler_transacoes_ativas(
                    lambda cols: (
                        supabase.table("transactions")
                        .select(cols)
                        .in_("tournament_id", tour_ids)
                        .in_("type", ENTRY_TYPES)
                    ),
                    "payment_method, amount",
                )
                for t in linhas:
                    code = t.get("payment_method") or None
                    total, count = somas.get(code, (Decimal("0"), 0))
                    somas[code] = (total + _dec(t.get("amount")), count + 1)
            linhas = [(code, total, count) for code, (total, count) in somas.items()]

        # Maior primeiro: é a ordem em que o operador confere a gaveta.
        linhas.sort(key=lambda item: (-item[1], item[0] or ""))

        methods = [PaymentMethodTotal(code=code, total=total, count=count) for code, total, count in linhas]
        return StagePaymentBreakdown(
            stage_id=stage_id,
            total=sum((m.total for m in methods), Decimal("0")),
            methods=methods,
        )

    @staticmethod
    def get_all_stage_cash() -> List[StageCashSummary]:
        """Get all stage cash registers with stage information"""
        response = (
            supabase.table("stage_cash_register")
            .select("*, stages(id, name, location, status)")
            .order("created_at", desc=True)
            .execute()
        )

        registers = response.data or []
        if not registers:
            return []

        # Tournament counts per stage in ONE round-trip (was one COUNT per
        # register = N+1), tallied in memory with a Counter (hash map).
        stage_ids = [r["stage_id"] for r in registers if r.get("stage_id")]
        tournament_rows = []
        if stage_ids:
            tournament_rows = (
                supabase.table("tournaments")
                .select("stage_id")
                .in_("stage_id", stage_ids)
                .execute()
                .data
                or []
            )
        counts = Counter(r["stage_id"] for r in tournament_rows if r.get("stage_id"))

        summaries = []
        for item in registers:
            stage = item.get("stages", {})
            stage_data = {k: v for k, v in item.items() if k != "stages"}

            summaries.append(StageCashSummary(
                stage_id=stage.get("id", ""),
                stage_name=stage.get("name", ""),
                stage_location=stage.get("location", ""),
                stage_status=stage.get("status", ""),
                cash_register=StageCashRegister(**stage_data),
                total_tournaments=counts.get(item["stage_id"], 0)
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

        # Idempotência (replay offline): se esta sangria já foi gravada (mesmo
        # client_mutation_id), devolve-a sem re-debitar os caixas.
        client_mutation_id = getattr(sangria_data, "client_mutation_id", None)
        if client_mutation_id:
            dup = supabase.table("sangria_transactions").select("*").eq("client_mutation_id", client_mutation_id).execute()
            if dup.data:
                return SangriaResponse(
                    success=True,
                    message="Sangria já sincronizada.",
                    sangria_transaction=SangriaTransaction(**dup.data[0]),
                    updated_stage_cash=CashRegisterService.get_stage_cash(sangria_data.stage_id),
                    updated_general_cash=CashRegisterService.get_general_cash(),
                    updated_rake=CashRegisterService.get_rake_register(),
                )

        # Get stage cash register
        stage_cash = CashRegisterService.get_stage_cash(sangria_data.stage_id)
        if not stage_cash:
            raise ErroDeNegocio(
                "caixa_da_etapa_nao_encontrado",
                "Esta etapa ainda não tem caixa aberto.",
                status=404,
                stage_id=sangria_data.stage_id,
            )

        # Validate sufficient balance
        if stage_cash.current_balance < sangria_data.amount:
            # Os dois valores vão como DADO, e não só dentro da frase: quem faz
            # a sangria precisa ver quanto há e quanto pediu para corrigir o
            # número na hora, e a tela remonta a frase no idioma dela.
            raise ErroDeNegocio(
                "saldo_insuficiente_na_etapa",
                f"Saldo insuficiente no caixa da etapa: há {stage_cash.current_balance} "
                f"e foram pedidos {sangria_data.amount}.",
                disponivel=stage_cash.current_balance,
                solicitado=sangria_data.amount,
            )

        # Rake derivado das transações (Fase 2 — caminho A): o rake é a soma dos
        # rakes por transação ainda não sangrados, proporcional ao valor sangrado.
        # O rake_percentage enviado pelo frontend é ignorado (mantido só por
        # compatibilidade do payload); o efetivo é gravado para registro.
        pending_rake = CashRegisterService.get_stage_pending_rake(sangria_data.stage_id)
        if stage_cash.current_balance > 0:
            rake_amount = (pending_rake * sangria_data.amount / stage_cash.current_balance).quantize(Decimal('0.01'))
        else:
            rake_amount = Decimal('0')
        if rake_amount > sangria_data.amount:
            rake_amount = sangria_data.amount
        rake_percentage = (
            (rake_amount / sangria_data.amount * Decimal('100')).quantize(Decimal('0.01'))
            if sangria_data.amount > 0 else Decimal('0')
        )
        net_amount = sangria_data.amount - rake_amount

        # Start transaction-like operations
        try:
            # 1. Update stage cash (subtract amount)
            new_stage_balance = stage_cash.current_balance - sangria_data.amount
            new_stage_sangrias = stage_cash.total_sangrias + sangria_data.amount

            supabase.table("stage_cash_register").update({
                "current_balance": str(new_stage_balance),
                "total_sangrias": str(new_stage_sangrias),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("stage_id", sangria_data.stage_id).execute()

            # 2. Update general cash (add net amount)
            general_cash = CashRegisterService.get_general_cash()
            new_general_balance = general_cash.current_balance + net_amount
            new_general_total = general_cash.total_received + net_amount

            supabase.table("general_cash_register").update({
                "current_balance": str(new_general_balance),
                "total_received": str(new_general_total),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }).eq("id", general_cash.id).execute()

            # 3. Update rake register (add rake amount)
            rake_register = CashRegisterService.get_rake_register()
            new_rake_total = rake_register.total_rake + rake_amount

            supabase.table("rake_register").update({
                "total_rake": str(new_rake_total),
                "updated_at": datetime.now(timezone.utc).isoformat()
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
            if client_mutation_id:
                sangria_record["client_mutation_id"] = client_mutation_id

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
