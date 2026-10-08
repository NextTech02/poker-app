from typing import Optional
from datetime import datetime
from decimal import Decimal
from app.database import supabase
from app.models.report import (
    ReportSummary,
    PlayerReport,
    TournamentReport,
    TournamentDayReport,
    TournamentPrizeRow,
    BuyTypeReportRow,
)
from app.services.transaction_filters import ler_transacoes_ativas

# Venda antiga sem meio cadastrado aparece pelo rótulo da categoria.
ROTULO_DA_CATEGORIA = {"buy_in": "Buy-in", "rebuy": "Rebuy", "addon": "Add-on"}
ORDEM_DA_CATEGORIA = {"buy_in": 0, "rebuy": 1, "addon": 2}


def agrupar_vendas_por_meio(linhas, ordem_por_id=None) -> list:
    """Agrupa vendas (`type, amount, buy_type_id, buy_type_name`) por MEIO de
    entrada — o cadastrado pelo diretor ("Buy-in", "Doble", "Tasa"…), não só
    a categoria fixa. A chave é o `buy_type_id`; o nome é o gravado na venda
    (o da época, mesmo que o meio tenha sido renomeado ou desativado). Venda
    antiga sem meio cai no rótulo da categoria. Ordem: categoria, depois a
    ordem do Caixa (`sort_order`), depois o nome."""
    grupos: dict = {}
    ordem = ordem_por_id or {}
    for linha in linhas or []:
        tipo = linha.get("type") or "buy_in"
        bid = linha.get("buy_type_id")
        chave = str(bid) if bid else f"cat:{tipo}"
        grupo = grupos.get(chave)
        if grupo is None:
            nome = (linha.get("buy_type_name") or "").strip() or ROTULO_DA_CATEGORIA.get(tipo, tipo)
            grupo = grupos[chave] = {
                "name": nome, "category": tipo, "count": 0, "amount": 0.0,
                "_ordem": ordem.get(chave, 10 ** 6),
            }
        grupo["count"] += 1
        grupo["amount"] += float(linha.get("amount") or 0)
    ordenados = sorted(
        grupos.values(),
        key=lambda g: (ORDEM_DA_CATEGORIA.get(g["category"], 9), g["_ordem"], g["name"].lower()),
    )
    return [
        BuyTypeReportRow(name=g["name"], category=g["category"], count=g["count"], amount=round(g["amount"], 2))
        for g in ordenados
    ]


class ReportService:

    @staticmethod
    def get_tournament_report(tournament_id: str) -> TournamentReport:
        """Comprehensive per-tournament report: participation, financials and
        prize execution (distributed vs reserved vs vagas)."""
        from fastapi import HTTPException

        t_resp = supabase.table("tournaments")\
            .select("*, sponsors(name)")\
            .eq("id", tournament_id)\
            .execute()
        if not t_resp.data:
            raise HTTPException(status_code=404, detail="Torneio não encontrado")
        t = t_resp.data[0]
        sponsor = t.pop("sponsors", None) or {}

        # ── Days ──
        days_resp = supabase.table("tournament_days")\
            .select("id, day_name, day_type, status, buy_in")\
            .eq("tournament_id", tournament_id)\
            .order("created_at")\
            .execute()
        days = days_resp.data or []

        # ── Participation per day (from tournament_players) ──
        # Batch: fetch all days' players in one query, then group in memory,
        # instead of one query per day (1 + N round-trips to a remote Postgres).
        day_ids = [d["id"] for d in days]
        tps_by_day: dict = {}
        dia_do_tp: dict = {}   # inscrição → dia, para rachar as vendas por dia
        if day_ids:
            all_tp_resp = supabase.table("tournament_players")\
                .select("id, tournament_day_id, player_id, status, buy_in_count, rebuy_count, addon_count, total_buy_in_amount, total_rebuy_amount, total_addon_amount")\
                .in_("tournament_day_id", day_ids)\
                .execute()
            for p in (all_tp_resp.data or []):
                if p.get("id"):
                    dia_do_tp[str(p["id"])] = p.get("tournament_day_id")
                # Inscrição com o buy-in cancelado não disputou o dia: a linha
                # fica na base por auditoria, mas contá-la faz o relatório
                # mostrar um jogador a mais do que sentou à mesa — e o perfil do
                # jogador exibir um torneio que ele não jogou. Os valores dela
                # já foram zerados no estorno; é a EXISTÊNCIA da linha que ainda
                # contava.
                if (p.get("status") or "") == "cancelled":
                    continue
                tps_by_day.setdefault(p.get("tournament_day_id"), []).append(p)

        # ── Vendas por MEIO de entrada (o cadastrado pelo diretor) ──
        # Lidas antes do laço dos dias para rachar por dia pela inscrição.
        # Entrada cancelada não é receita do torneio.
        linhas_tx = ler_transacoes_ativas(
            lambda cols: (
                supabase.table("transactions")
                .select(cols)
                .eq("tournament_id", tournament_id)
                .in_("type", ["buy_in", "rebuy", "addon"])
            ),
            "amount, type, buy_type_id, buy_type_name, tournament_player_id",
        )
        ordem_dos_meios = ReportService._ordem_dos_meios(tournament_id)

        day_reports = []
        distinct_players = set()
        tot_buy_ins = tot_rebuys = tot_addons = 0
        for d in days:
            tps = tps_by_day.get(d["id"], [])
            d_buy_ins = sum(int(p.get("buy_in_count") or 0) for p in tps)
            d_rebuys = sum(int(p.get("rebuy_count") or 0) for p in tps)
            d_addons = sum(int(p.get("addon_count") or 0) for p in tps)
            d_rev = sum(
                float(p.get("total_buy_in_amount") or 0)
                + float(p.get("total_rebuy_amount") or 0)
                + float(p.get("total_addon_amount") or 0)
                for p in tps
            )
            for p in tps:
                if p.get("player_id"):
                    distinct_players.add(p["player_id"])
            tot_buy_ins += d_buy_ins
            tot_rebuys += d_rebuys
            tot_addons += d_addons
            day_reports.append(TournamentDayReport(
                day_id=d["id"],
                day_name=d.get("day_name") or "",
                day_type=d.get("day_type"),
                status=d.get("status"),
                buy_in=float(d.get("buy_in") or 0),
                players=len({p["player_id"] for p in tps if p.get("player_id")}),
                buy_ins=d_buy_ins,
                rebuys=d_rebuys,
                addons=d_addons,
                revenue=d_rev,
                by_buy_type=agrupar_vendas_por_meio(
                    [x for x in linhas_tx if dia_do_tp.get(str(x.get("tournament_player_id") or "")) == d["id"]],
                    ordem_dos_meios,
                ),
            ))

        # ── Revenue from transactions ──
        total_revenue = sum(float(x["amount"]) for x in linhas_tx)

        # ── Prize pool + reserved (reuse PrizeAllocationService) ──
        from app.services.prize_allocation_service import PrizeAllocationService
        summary = PrizeAllocationService.get_prize_summary(tournament_id)

        # ── Prize allocations detail ──
        alloc_resp = supabase.table("prize_allocations")\
            .select("*, players(name)")\
            .eq("tournament_id", tournament_id)\
            .order("position")\
            .execute()
        allocs = alloc_resp.data or []
        prize_rows = []
        total_distributed = 0.0
        pending_release = 0
        vagas_count = 0
        vagas_generated = 0
        for a in allocs:
            pname = (a.get("players") or {}).get("name")
            ptype = a.get("prize_type", "cash")
            paid = bool(a.get("paid"))
            if paid and ptype == "cash":
                total_distributed += float(a.get("prize_amount") or 0)
            if not a.get("released"):
                pending_release += 1
            if ptype == "vaga":
                vagas_count += 1
                if a.get("generated_ticket_id"):
                    vagas_generated += 1
            prize_rows.append(TournamentPrizeRow(
                position=a["position"],
                prize_type=ptype,
                prize_amount=float(a.get("prize_amount") or 0),
                player_name=pname,
                released=bool(a.get("released")),
                paid=paid,
                visible=a.get("visible", True),
            ))

        return TournamentReport(
            tournament_id=tournament_id,
            tournament_name=t.get("name") or "",
            sponsor_name=sponsor.get("name"),
            status=t.get("status"),
            has_qualifying=bool(t.get("has_qualifying")),
            is_satellite=bool(t.get("is_satellite")),
            total_players=len(distinct_players),
            # ENTRADA = buy-in. Quem recompra voltou ao torneio, nao entrou nele
            # de novo; quem faz add-on ja estava na mesa. As duas coisas
            # continuam visiveis em total_rebuys/total_addons — e o dinheiro
            # delas, inteiro, em total_revenue.
            total_entries=tot_buy_ins,
            total_buy_ins=tot_buy_ins,
            total_rebuys=tot_rebuys,
            total_addons=tot_addons,
            total_revenue=total_revenue,
            rake_percentage=float(summary.rake_percentage),
            # Rake real (Fase 1): rake = entradas brutas − pool dos jogadores
            # (= soma do rake por transação), em vez de recalcular por %.
            rake_amount=float(Decimal(str(summary.total_entries)) - Decimal(str(summary.player_pool))),
            guaranteed_prize=float(summary.guaranteed_prize),
            available_prize_pool=float(summary.available_prize_pool),
            reserved_prize_percentage=float(summary.reserved_prize_percentage),
            reserved_purpose=summary.reserved_purpose,
            reserved_amount=float(summary.reserved_amount),
            payable_pool=float(summary.payable_pool),
            total_allocated=float(summary.total_allocated),
            total_distributed=total_distributed,
            pending_release=pending_release,
            vagas_count=vagas_count,
            vagas_generated=vagas_generated,
            days=day_reports,
            prizes=prize_rows,
            by_buy_type=agrupar_vendas_por_meio(linhas_tx, ordem_dos_meios),
        )

    @staticmethod
    def _ordem_dos_meios(tournament_id: str) -> dict:
        """{buy_type_id: sort_order} dos meios do torneio (ativos ou não — o
        relatório é histórico), para listar na ordem do Caixa. Erro → {}."""
        try:
            resp = supabase.table("buy_types")\
                .select("id, sort_order")\
                .eq("tournament_id", tournament_id)\
                .execute()
        except Exception:
            return {}
        return {str(r["id"]): int(r.get("sort_order") or 0) for r in (resp.data or []) if r.get("id")}

    @staticmethod
    def get_reports(start_date: Optional[str] = None, end_date: Optional[str] = None) -> ReportSummary:
        """Generate comprehensive reports for a date range"""

        # Fim do período inclui o dia inteiro.
        end_param = None
        if end_date:
            end_datetime = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
            end_param = end_datetime.isoformat()

        # Totais de transações agregados NO BANCO (1 round-trip) em vez de buscar
        # a tabela inteira e somar em Python. Fallback ao fetch+soma se a RPC sumir.
        total_revenue = 0.0
        total_buy_ins = total_rebuys = total_addons = 0
        avg_buy_in = 0.0
        try:
            r = supabase.rpc("get_reports_totals", {"p_start": start_date, "p_end": end_param}).execute()
            if r.data:
                row = r.data[0]
                total_revenue = float(row.get("total_revenue") or 0)
                total_buy_ins = int(row.get("total_buy_ins") or 0)
                total_rebuys = int(row.get("total_rebuys") or 0)
                total_addons = int(row.get("total_addons") or 0)
                avg_buy_in = float(row.get("avg_buy_in") or 0)
        except Exception:
            def _monta(cols):
                q = supabase.table("transactions").select(cols)
                if start_date:
                    q = q.gte("created_at", start_date)
                if end_param:
                    q = q.lte("created_at", end_param)
                return q

            transactions = ler_transacoes_ativas(_monta, "type, amount")
            total_revenue = sum(float(t["amount"]) for t in transactions if t["type"] in ["buy_in", "rebuy", "addon"])
            total_buy_ins = sum(1 for t in transactions if t["type"] == "buy_in")
            total_rebuys = sum(1 for t in transactions if t["type"] == "rebuy")
            total_addons = sum(1 for t in transactions if t["type"] == "addon")
            buy_in_amounts = [float(t["amount"]) for t in transactions if t["type"] == "buy_in"]
            avg_buy_in = sum(buy_in_amounts) / len(buy_in_amounts) if buy_in_amounts else 0

        # ENTRADA = buy-in (ver TournamentReport acima). Recompra e add-on tem
        # os seus proprios numeros logo abaixo, e a receita soma as tres.
        total_entries = total_buy_ins

        # ── Vendas do período por MEIO de entrada (o cadastrado pelo diretor) ──
        # O diretor cadastra "Doble", "Tasa"…; só as três categorias fixas não
        # contam a história. Uma leitura das vendas do período, por jogador.
        def _monta_meios(cols):
            q = supabase.table("transactions").select(cols).in_("type", ["buy_in", "rebuy", "addon"])
            if start_date:
                q = q.gte("created_at", start_date)
            if end_param:
                q = q.lte("created_at", end_param)
            return q

        try:
            vendas = ler_transacoes_ativas(_monta_meios, "type, amount, buy_type_id, buy_type_name, player_id")
        except Exception:
            vendas = []
        by_buy_type = agrupar_vendas_por_meio(vendas)
        meios_por_jogador: dict = {}
        for v in vendas:
            pid = str(v.get("player_id") or "")
            if not pid:
                continue
            nome = (v.get("buy_type_name") or "").strip() or ROTULO_DA_CATEGORIA.get(v.get("type") or "buy_in", v.get("type") or "buy_in")
            por_meio = meios_por_jogador.setdefault(pid, {})
            por_meio[nome] = por_meio.get(nome, 0) + 1

        # Get tournament count
        tournament_query = supabase.table("tournaments").select("id", count="exact")
        if start_date:
            tournament_query = tournament_query.gte("created_at", start_date)
        if end_date:
            tournament_query = tournament_query.lte("created_at", end_date)

        tournament_count = tournament_query.execute().count or 0

        # Generate player reports from tournament_players data
        player_query = supabase.table("tournament_players").select("*, players(name)")
        player_data = []

        if start_date or end_date:
            # Filtra pelos torneios criados no período.
            date_query = supabase.table("tournaments").select("id")
            if start_date:
                date_query = date_query.gte("created_at", start_date)
            if end_date:
                date_query = date_query.lte("created_at", end_date)
            tournament_ids = [t["id"] for t in (date_query.execute().data or [])]
            if tournament_ids:
                player_data = player_query.in_("tournament_id", tournament_ids).execute().data or []
            # senão: sem torneios no período → player_data fica vazio
        else:
            player_data = player_query.execute().data or []

        # Aggregate player stats
        player_stats = {}
        jogadores_ja_somados = set()
        for tp in player_data:
            player_info = tp.get("players") or {}
            player_name = player_info.get("name", "Unknown")

            if player_name not in player_stats:
                player_stats[player_name] = {
                    "player_name": player_name,
                    "total_entries": 0,
                    "buy_ins": 0,
                    "rebuys": 0,
                    "addons": 0,
                    "total_spent": 0.0,
                    "by_buy_type": {},
                }

            player_stats[player_name]["total_entries"] += tp["buy_in_count"]
            player_stats[player_name]["buy_ins"] += tp["buy_in_count"]
            player_stats[player_name]["rebuys"] += tp["rebuy_count"]
            player_stats[player_name]["addons"] += tp["addon_count"]
            player_stats[player_name]["total_spent"] += float(tp["total_spent"])
            # Por meio: as vendas do jogador no período, somadas UMA vez por
            # jogador (ele aparece em várias inscrições).
            pid = str(tp.get("player_id") or "")
            if pid and pid not in jogadores_ja_somados:
                jogadores_ja_somados.add(pid)
                acumulado = player_stats[player_name]["by_buy_type"]
                for nome, n in meios_por_jogador.get(pid, {}).items():
                    acumulado[nome] = acumulado.get(nome, 0) + n

        player_reports = [PlayerReport(**stats) for stats in player_stats.values()]

        return ReportSummary(
            totalRevenue=total_revenue,
            totalTournaments=tournament_count,
            totalPlayers=total_entries,
            avgBuyIn=avg_buy_in,
            totalBuyIns=total_buy_ins,
            totalRebuys=total_rebuys,
            totalAddons=total_addons,
            playerReports=player_reports,
            byBuyType=by_buy_type,
        )
