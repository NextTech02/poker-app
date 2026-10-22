from typing import Optional
from datetime import datetime
from app.database import supabase
from app.models.financial import (
    FinancialSummary,
    RevenueBreakdown,
    TournamentFinancial,
    TransactionEntry,
    ExpenseCategoryTotal,
)
from app.services.cash_report_service import CashReportService
from app.services.bar_report_service import BarReportService
from app.services.expense_service import ExpenseService
from app.services.house_credit_service import HouseCreditService
from app.services.transaction_filters import sem_canceladas


class FinancialService:
    @staticmethod
    def get_financial_summary(
        stage_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        tournament_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> FinancialSummary:
        """Generate comprehensive financial summary for DRE and closing"""

        # ── 1. Transactions ──
        query = supabase.table("transactions").select(
            "*, players(name), tournaments(name)"
        )

        if stage_id:
            # Get tournament IDs for this stage
            stage_tournaments = supabase.table("tournaments").select("id") \
                .eq("stage_id", stage_id).execute()
            t_ids = [t["id"] for t in (stage_tournaments.data or [])]
            if t_ids:
                query = query.in_("tournament_id", t_ids)
            else:
                # Etapa ainda sem torneios: não há receita, mas pode já haver
                # despesa lançada (aluguel, montagem). O DRE precisa mostrar o
                # prejuízo — devolver zerado esconderia dinheiro já gasto.
                exp = ExpenseService.summarize(
                    organization_id, stage_id, tournament_id, start_date, end_date
                )
                rev = ExpenseService.summarize_revenues(
                    organization_id, stage_id, tournament_id, start_date, end_date
                )
                # Um clube que só faz cash game cai SEMPRE aqui: ele não
                # tem torneio nenhum. Devolver zerado faria o DRE dele mostrar
                # nada para sempre — e é o único DRE que ele tem.
                cash = CashReportService.summarize(
                    organization_id, start_date, end_date
                )
                # O bar também não tem etapa: um clube só de bar cai aqui.
                bar = BarReportService.summarize(organization_id, start_date, end_date)
                fiado = HouseCreditService.summarize(organization_id, start_date, end_date)
                perdas = fiado["house_credit_write_offs"]
                bruto = cash["cash_revenue"] + bar["bar_revenue"]
                return FinancialSummary(
                    revenue=RevenueBreakdown(),
                    gross_revenue=bruto,
                    prizes=0,
                    operational_result=bruto,
                    rake=cash["cash_revenue"],
                    **cash,
                    **bar,
                    **fiado,
                    expenses=exp["total"],
                    expenses_paid=exp["paid"],
                    expenses_pending=exp["pending"],
                    expenses_by_category=[ExpenseCategoryTotal(**c) for c in exp["by_category"]],
                    other_revenue=rev["total"],
                    other_revenue_received=rev["received"],
                    other_revenue_pending=rev["pending"],
                    other_revenue_by_source=[ExpenseCategoryTotal(**c) for c in rev["by_source"]],
                    net_result=bruto + rev["total"] - exp["total"] - perdas,
                    # Etapa sem torneio: o DRE de torneio é só o que já se
                    # gastou (e as outras receitas lançadas nela).
                    tournament_net_result=rev["total"] - exp["total"],
                    cash_net_result=cash["cash_revenue"] - perdas,
                )

        # Filtro por torneio específico (compõe com etapa/datas).
        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if start_date:
            query = query.gte("created_at", start_date)
        if end_date:
            end_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
            query = query.lte("created_at", end_dt.isoformat())

        # Venda cancelada sai do DRE inteiro (receita, extrato e por torneio):
        # o dinheiro foi devolvido, então contá-la mostraria um lucro que o
        # clube não teve. A consulta usa select("*"), então o filtro é aqui em
        # Python — assim continua funcionando antes da migração da coluna.
        transactions_data = sem_canceladas(
            query.order("created_at", desc=True).execute().data or []
        )

        # ── 2. Revenue breakdown ──
        buy_in_total = 0.0
        rebuy_total = 0.0
        addon_total = 0.0
        fee_total = 0.0
        prize_total = 0.0
        knockout_total = 0.0

        # Per-tournament aggregation
        tournament_map = {}

        # Transaction entries for extract
        tx_entries = []

        for tx in transactions_data:
            amount = float(tx.get("amount") or 0)
            tx_type = tx.get("type", "")
            t_id = tx.get("tournament_id")
            t_name = (tx.get("tournaments") or {}).get("name", "")
            p_name = (tx.get("players") or {}).get("name", "")

            # Aggregate by type
            if tx_type == "buy_in":
                buy_in_total += amount
            elif tx_type == "rebuy":
                rebuy_total += amount
            elif tx_type == "addon" and tx.get("is_fee"):
                # Taxa: mesmo caminho do add-on, linha própria no DRE.
                fee_total += amount
            elif tx_type == "addon":
                addon_total += amount
            elif tx_type == "prize":
                prize_total += amount
                # O KO sai do mesmo pozo (é prêmio), mas o diretor quer ver
                # quanto foi por eliminação e quanto por posição.
                if tx.get("prize_kind") == "knockout":
                    knockout_total += amount

            # Per-tournament
            if t_id and t_id not in tournament_map:
                tournament_map[t_id] = {
                    "tournament_id": t_id,
                    "tournament_name": t_name,
                    "players": set(),
                    "buy_ins_count": 0,
                    "rebuys_count": 0,
                    "addons_count": 0,
                    "fees_count": 0,
                    "revenue": 0.0,
                    "prizes": 0.0,
                    "vendas": [],
                }

            if t_id:
                tm = tournament_map[t_id]
                if tx.get("player_id"):
                    tm["players"].add(tx["player_id"])
                if tx_type in ("buy_in", "rebuy", "addon"):
                    tm["vendas"].append(tx)
                if tx_type == "buy_in":
                    tm["buy_ins_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "rebuy":
                    tm["rebuys_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "addon" and tx.get("is_fee"):
                    tm["fees_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "addon":
                    tm["addons_count"] += 1
                    tm["revenue"] += amount
                elif tx_type == "prize":
                    tm["prizes"] += amount

            # Transaction entry
            tx_entries.append(TransactionEntry(
                id=tx["id"],
                created_at=tx["created_at"],
                tournament_name=t_name,
                player_name=p_name,
                type=tx_type,
                payment_source=tx.get("payment_source"),
                payment_method=tx.get("payment_method"),
                amount=amount,
                buy_type_name=tx.get("buy_type_name"),
                is_fee=bool(tx.get("is_fee")),
                prize_kind=tx.get("prize_kind"),
            ))

        revenue_total = buy_in_total + rebuy_total + addon_total + fee_total

        # ── 3. Tickets redeemed value ──
        tickets_query = supabase.table("satellite_tickets").select("ticket_value") \
            .eq("status", "redeemed")
        if stage_id:
            tickets_query = tickets_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
        if start_date:
            tickets_query = tickets_query.gte("redeemed_at", start_date)
        if end_date:
            end_dt = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
            tickets_query = tickets_query.lte("redeemed_at", end_dt.isoformat())

        redeemed_tickets = tickets_query.execute().data or []
        tickets_redeemed_value = sum(float(t.get("ticket_value") or 0) for t in redeemed_tickets)

        # ── 4. Rake — soma do rake REAL por transação (Fase 1: tipos de buy).
        # Antes lia rake_register.total_rake (global, alimentado pela sangria).
        # Agora soma transactions.rake_amount do período/etapa filtrados, então o
        # rake reflete o % real de cada tipo de buy e respeita os filtros.
        rake_total = sum(
            float(tx.get("rake_amount") or 0)
            for tx in transactions_data
            if tx.get("type") in ("buy_in", "rebuy", "addon")
        )

        # ── 5. Pending credits ──
        pending_credits = 0.0
        try:
            credits_query = supabase.table("player_credits").select("amount, used_amount") \
                .eq("status", "active")
            if stage_id:
                credits_query = credits_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
            credits_data = credits_query.execute().data or []
            pending_credits = sum(
                float(c.get("amount") or 0) - float(c.get("used_amount") or 0)
                for c in credits_data
            )
        except Exception:
            pass

        # ── 6. Available tickets count ──
        available_tickets = 0
        try:
            avail_query = supabase.table("satellite_tickets").select("id", count="exact") \
                .eq("status", "available")
            if stage_id:
                avail_query = avail_query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
            avail_resp = avail_query.execute()
            available_tickets = avail_resp.count or 0
        except Exception:
            pass

        # ── 7. Build tournament list ──
        # Vendas por meio de entrada de cada torneio, na ordem do Caixa
        # (uma consulta para todos os torneios do período).
        from app.services.report_service import agrupar_vendas_por_meio
        ordem_dos_meios: dict = {}
        if tournament_map:
            try:
                meios = (
                    supabase.table("buy_types").select("id, sort_order")
                    .in_("tournament_id", list(tournament_map)).execute().data or []
                )
                ordem_dos_meios = {str(m["id"]): int(m.get("sort_order") or 0) for m in meios if m.get("id")}
            except Exception:
                ordem_dos_meios = {}   # só a ordem; os grupos saem do mesmo jeito

        by_tournament = []
        for tm in tournament_map.values():
            by_tournament.append(TournamentFinancial(
                tournament_id=tm["tournament_id"],
                tournament_name=tm["tournament_name"],
                players=len(tm["players"]),
                buy_ins_count=tm["buy_ins_count"],
                rebuys_count=tm["rebuys_count"],
                addons_count=tm["addons_count"],
                fees_count=tm["fees_count"],
                revenue=tm["revenue"],
                prizes=tm["prizes"],
                net=tm["revenue"] - tm["prizes"],
                by_buy_type=agrupar_vendas_por_meio(tm["vendas"], ordem_dos_meios),
            ))

        by_tournament.sort(key=lambda t: t.revenue, reverse=True)

        # ── 8. Despesas da etapa ──
        # É o que faltava para o DRE fechar: antes `net_result` era igual ao
        # operacional, ou seja, o resultado ignorava todo custo da operação.
        exp = ExpenseService.summarize(
            organization_id, stage_id, tournament_id, start_date, end_date
        )
        # ── 9. Outras receitas (bar, patrocínio, aluguel) ──
        # Faturamento que não passa pelo caixa de torneio e ficava fora do DRE.
        rev = ExpenseService.summarize_revenues(
            organization_id, stage_id, tournament_id, start_date, end_date
        )

        # ── 10. Cash game ──
        # O rake do cash é receita como a entrada de torneio. O buy-in NÃO: é
        # troca de dinheiro por ficha, e a maior parte volta ao jogador.
        cash = CashReportService.summarize(organization_id, start_date, end_date)

        # ── 11. Bar ──
        # A comanda fechada é receita como a entrada de torneio. O CMV vem
        # junto como informação (a compra já é despesa — não subtrair 2x).
        bar = BarReportService.summarize(organization_id, start_date, end_date)

        # ── 12. Fiado da casa ──
        # A baixa é perda do período (despesa); o recebível em aberto é só
        # informação — não é receita enquanto não volta.
        fiado = HouseCreditService.summarize(organization_id, start_date, end_date)
        perdas = fiado["house_credit_write_offs"]

        gross_revenue = revenue_total + cash["cash_revenue"] + bar["bar_revenue"]
        # O cash não paga prêmio: o dinheiro que sai é cash-out, que é a
        # devolução das fichas do próprio jogador.
        operational_result = gross_revenue - prize_total
        net_result = operational_result + rev["total"] - exp["total"] - perdas

        return FinancialSummary(
            revenue=RevenueBreakdown(
                buy_ins=buy_in_total,
                rebuys=rebuy_total,
                addons=addon_total,
                fees=fee_total,
                total=revenue_total,
            ),
            tickets_redeemed_value=tickets_redeemed_value,
            gross_revenue=gross_revenue,
            prizes=prize_total,
            knockout_prizes=knockout_total,
            operational_result=operational_result,
            rake=rake_total + cash["cash_revenue"],
            **cash,
            **bar,
            **fiado,
            expenses=exp["total"],
            expenses_paid=exp["paid"],
            expenses_pending=exp["pending"],
            expenses_by_category=[ExpenseCategoryTotal(**c) for c in exp["by_category"]],
            guarantee_committed=ExpenseService.guarantee_committed(
                organization_id, stage_id, tournament_id
            ),
            other_revenue=rev["total"],
            other_revenue_received=rev["received"],
            other_revenue_pending=rev["pending"],
            other_revenue_by_source=[ExpenseCategoryTotal(**c) for c in rev["by_source"]],
            net_result=net_result,
            tournament_gross_revenue=revenue_total,
            tournament_rake=rake_total,
            tournament_operational_result=revenue_total - prize_total,
            tournament_net_result=revenue_total - prize_total + rev["total"] - exp["total"],
            cash_net_result=cash["cash_revenue"] - perdas,
            pending_credits=pending_credits,
            available_tickets=available_tickets,
            by_tournament=by_tournament,
            transactions=tx_entries,
        )
