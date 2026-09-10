"""Faturamento do cash game: por dia, por dia da semana, por mesa, por jogador.

ESTE É O MÓDULO QUE MOTIVOU O CASH GAME. A pergunta do cliente não era "quanto
entrou de dinheiro", era "quanto faturamos em cada dia, e qual dia rende mais".

TRÊS NÚMEROS QUE NÃO SE MISTURAM, e cujo embaralhamento é o erro mais fácil de
cometer aqui:

  - **rake** — a receita da casa. É o que foi CONTADO na caixa da mesa.
  - **buy-ins** — o giro. Troca de dinheiro por ficha; a maior parte volta ao
    jogador no cash-out. Chamar isso de faturamento multiplica a receita do
    clube por dez no papel.
  - **jackpot** — passivo. Dinheiro dos jogadores retido para pagamento futuro.

A agregação tenta a RPC `cash_daily_revenue` e cai para a soma em Python quando
ela não existe — o padrão do projeto para RPC de agregação, que mantém o deploy
do código independente do da migração.
"""
import logging
from collections import defaultdict
from datetime import date, datetime
from typing import List, Optional

from app.database import supabase

logger = logging.getLogger(__name__)

# Segunda = 0, como no `weekday()` do Python.
DIAS_DA_SEMANA = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _data(valor) -> Optional[date]:
    if isinstance(valor, date) and not isinstance(valor, datetime):
        return valor
    if isinstance(valor, datetime):
        return valor.date()
    if not valor:
        return None
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError:
        return None


class CashReportService:

    # ============================================================
    # Série por dia
    # ============================================================

    @staticmethod
    def daily(
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> List[dict]:
        """Uma linha por dia de operação, do mais recente para o mais antigo."""
        via_rpc = CashReportService._via_rpc(date_from, date_to)
        if via_rpc is not None:
            return via_rpc
        return CashReportService._em_python(date_from, date_to, organization_id)

    @staticmethod
    def _via_rpc(date_from: Optional[str], date_to: Optional[str]) -> Optional[List[dict]]:
        try:
            resp = supabase.rpc(
                "cash_daily_revenue", {"p_from": date_from, "p_to": date_to}
            ).execute()
        except Exception:
            # A RPC ainda não existe no banco (deploy do código antes da
            # migração). O fallback dá o mesmo número, só mais devagar.
            return None
        linhas = resp.data or []
        return [
            {
                "cash_day_id": l.get("cash_day_id"),
                "business_date": str(l.get("business_date")),
                "status": l.get("status"),
                "revenue": round(float(l.get("rake") or 0), 2),
                "jackpot": round(float(l.get("jackpot") or 0), 2),
                "buy_ins": round(float(l.get("buy_ins") or 0), 2),
                "cash_outs": round(float(l.get("cash_outs") or 0), 2),
                "tables_count": int(l.get("tables_count") or 0),
                "players_count": int(l.get("players_count") or 0),
            }
            for l in linhas
        ]

    @staticmethod
    def _em_python(
        date_from: Optional[str],
        date_to: Optional[str],
        organization_id: Optional[str],
    ) -> List[dict]:
        """Mesma agregação, em QUATRO consultas — não uma por dia.

        Um laço com query dentro (o N+1 clássico deste projeto) faria um
        relatório de 90 dias disparar centenas de idas ao banco.
        """
        if not CashReportService._modulo_migrado():
            return []
        query = supabase.table("cash_days").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if date_from:
            query = query.gte("business_date", date_from)
        if date_to:
            query = query.lte("business_date", date_to)
        dias = query.order("business_date", desc=True).execute().data or []
        if not dias:
            return []

        ids = [d["id"] for d in dias]

        rakes = supabase.table("cash_rake_entries").select(
            "cash_day_id, rake_amount, jackpot_amount"
        ).in_("cash_day_id", ids).execute().data or []
        movimentos = supabase.table("cash_transactions").select(
            "cash_day_id, type, amount, status"
        ).in_("cash_day_id", ids).execute().data or []
        mesas = supabase.table("cash_tables").select("cash_day_id, id") \
            .in_("cash_day_id", ids).execute().data or []
        sessoes = supabase.table("cash_player_sessions").select("cash_day_id, player_id") \
            .in_("cash_day_id", ids).execute().data or []

        rake = defaultdict(float)
        jackpot = defaultdict(float)
        for r in rakes:
            rake[r["cash_day_id"]] += float(r.get("rake_amount") or 0)
            jackpot[r["cash_day_id"]] += float(r.get("jackpot_amount") or 0)

        entradas = defaultdict(float)
        saidas = defaultdict(float)
        for t in movimentos:
            if (t.get("status") or "active") != "active":
                continue  # cancelada: o dinheiro voltou para a mão do jogador
            valor = float(t.get("amount") or 0)
            if t.get("type") in ("buy_in", "rebuy"):
                entradas[t["cash_day_id"]] += valor
            elif t.get("type") in ("cash_out", "jackpot_payout"):
                saidas[t["cash_day_id"]] += valor

        qtd_mesas = defaultdict(int)
        for m in mesas:
            qtd_mesas[m["cash_day_id"]] += 1

        jogadores = defaultdict(set)
        for s in sessoes:
            if s.get("player_id"):
                jogadores[s["cash_day_id"]].add(s["player_id"])

        return [
            {
                "cash_day_id": d["id"],
                "business_date": str(d.get("business_date")),
                "status": d.get("status"),
                "revenue": round(rake[d["id"]], 2),
                "jackpot": round(jackpot[d["id"]], 2),
                "buy_ins": round(entradas[d["id"]], 2),
                "cash_outs": round(saidas[d["id"]], 2),
                "tables_count": qtd_mesas[d["id"]],
                "players_count": len(jogadores[d["id"]]),
            }
            for d in dias
        ]

    @staticmethod
    def _modulo_migrado() -> bool:
        """As tabelas de cash existem?

        O deploy do código precede o da migração neste projeto (as migrações
        são aplicadas à mão no SQL Editor). Entre um e outro, `cash_days` não
        existe — e SEM esta guarda o DRE do clube de TORNEIO, que não tem nada
        a ver com cash, pararia de abrir com um erro de tabela ausente.

        Zero é a resposta honesta no intervalo: não há operação de cash
        registrada.
        """
        try:
            supabase.table("cash_days").select("id").limit(1).execute()
            return True
        except Exception:
            logger.warning("cash_days indisponível; o DRE segue sem os números de cash")
            return False

    # ============================================================
    # Melhores dias
    # ============================================================

    @staticmethod
    def best_days(
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: int = 10,
        organization_id: Optional[str] = None,
    ) -> List[dict]:
        """Os dias que mais renderam, por RAKE.

        Ordenar por buy-ins responderia "qual noite girou mais dinheiro", que é
        outra pergunta — e levaria o clube a repetir a noite que movimentou
        muito e ganhou pouco.
        """
        linhas = CashReportService.daily(date_from, date_to, organization_id)
        return sorted(linhas, key=lambda l: l["revenue"], reverse=True)[:limit]

    # ============================================================
    # Média por dia da semana
    # ============================================================

    @staticmethod
    def by_weekday(
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> List[dict]:
        """Quanto rende, em média, cada dia da semana.

        A MÉDIA, e não o total: o período quase nunca tem o mesmo número de
        sextas e de terças, e o total premiaria o dia que simplesmente
        apareceu mais vezes no recorte.
        """
        linhas = CashReportService.daily(date_from, date_to, organization_id)
        por_dia = defaultdict(lambda: {"dias": 0, "rake": 0.0, "jogadores": 0})
        for l in linhas:
            dia = _data(l["business_date"])
            if dia is None:
                continue
            alvo = por_dia[dia.weekday()]
            alvo["dias"] += 1
            alvo["rake"] += l["revenue"]
            alvo["jogadores"] += l["players_count"]

        saida = []
        for indice, nome in enumerate(DIAS_DA_SEMANA):
            agg = por_dia.get(indice)
            dias = agg["dias"] if agg else 0
            saida.append({
                "weekday": indice,
                "weekday_key": nome,
                "days": dias,
                "total_revenue": round(agg["rake"], 2) if agg else 0.0,
                "avg_revenue": round(agg["rake"] / dias, 2) if dias else 0.0,
                "avg_players": round(agg["jogadores"] / dias, 1) if dias else 0.0,
            })
        return saida

    # ============================================================
    # Por mesa e por jogador
    # ============================================================

    @staticmethod
    def by_table(
        cash_day_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> List[dict]:
        """Rake por mesa — é o que diz qual stake vale a pena manter aberto."""
        ids = CashReportService._dias_no_periodo(
            cash_day_id, date_from, date_to, organization_id
        )
        if not ids:
            return []

        mesas = supabase.table("cash_tables").select("*") \
            .in_("cash_day_id", ids).execute().data or []
        if not mesas:
            return []
        mesa_ids = [m["id"] for m in mesas]

        rakes = supabase.table("cash_rake_entries").select(
            "table_id, rake_amount, jackpot_amount"
        ).in_("table_id", mesa_ids).execute().data or []
        sessoes = supabase.table("cash_player_sessions").select(
            "table_id, player_id, total_buy_in"
        ).in_("table_id", mesa_ids).execute().data or []

        rake = defaultdict(float)
        jackpot = defaultdict(float)
        for r in rakes:
            rake[r["table_id"]] += float(r.get("rake_amount") or 0)
            jackpot[r["table_id"]] += float(r.get("jackpot_amount") or 0)

        jogadores = defaultdict(set)
        entradas = defaultdict(float)
        for s in sessoes:
            if s.get("player_id"):
                jogadores[s["table_id"]].add(s["player_id"])
            entradas[s["table_id"]] += float(s.get("total_buy_in") or 0)

        tipos = list({m["game_type_id"] for m in mesas if m.get("game_type_id")})
        nomes = {}
        if tipos:
            linhas = supabase.table("cash_game_types").select("id, name") \
                .in_("id", tipos).execute().data or []
            nomes = {r["id"]: r.get("name") for r in linhas}

        saida = [
            {
                "table_id": m["id"],
                "cash_day_id": m["cash_day_id"],
                "table_number": m.get("table_number"),
                "game_type_name": nomes.get(m.get("game_type_id")),
                "small_blind": float(m.get("small_blind") or 0),
                "big_blind": float(m.get("big_blind") or 0),
                "status": m.get("status"),
                "revenue": round(rake[m["id"]], 2),
                "jackpot": round(jackpot[m["id"]], 2),
                "buy_ins": round(entradas[m["id"]], 2),
                "players_count": len(jogadores[m["id"]]),
                "hours": CashReportService._horas(m.get("opened_at"), m.get("closed_at")),
            }
            for m in mesas
        ]
        return sorted(saida, key=lambda l: l["revenue"], reverse=True)

    @staticmethod
    def by_player(
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        limit: int = 50,
        organization_id: Optional[str] = None,
    ) -> List[dict]:
        """Quem joga, quanto compra e quanto leva.

        `result` é o resultado do JOGADOR: positivo significa que ele saiu
        ganhando. Não é despesa do clube — o dinheiro veio dos outros jogadores
        da mesa, não do caixa.
        """
        ids = CashReportService._dias_no_periodo(None, date_from, date_to, organization_id)
        if not ids:
            return []

        sessoes = supabase.table("cash_player_sessions").select(
            "player_id, cash_day_id, total_buy_in, total_cash_out, started_at, ended_at"
        ).in_("cash_day_id", ids).execute().data or []
        if not sessoes:
            return []

        agg = defaultdict(lambda: {"sessions": 0, "days": set(), "buy_in": 0.0,
                                   "cash_out": 0.0, "hours": 0.0})
        for s in sessoes:
            jogador = s.get("player_id")
            if not jogador:
                continue
            alvo = agg[jogador]
            alvo["sessions"] += 1
            alvo["days"].add(s.get("cash_day_id"))
            alvo["buy_in"] += float(s.get("total_buy_in") or 0)
            alvo["cash_out"] += float(s.get("total_cash_out") or 0)
            alvo["hours"] += CashReportService._horas(s.get("started_at"), s.get("ended_at"))

        nomes = {}
        rows = supabase.table("players").select("id, name, nickname") \
            .in_("id", list(agg.keys())).execute().data or []
        nomes = {r["id"]: (r.get("nickname") or r.get("name")) for r in rows}

        saida = [
            {
                "player_id": pid,
                "player_name": nomes.get(pid),
                "sessions": v["sessions"],
                "days": len(v["days"]),
                "buy_ins": round(v["buy_in"], 2),
                "cash_outs": round(v["cash_out"], 2),
                "result": round(v["cash_out"] - v["buy_in"], 2),
                "hours": round(v["hours"], 1),
            }
            for pid, v in agg.items()
        ]
        # Ordenado por VOLUME, não por resultado: quem mais joga é quem mais
        # gera rake, e é essa a lista que interessa ao clube.
        return sorted(saida, key=lambda l: l["buy_ins"], reverse=True)[:limit]

    # ============================================================
    # Para o DRE
    # ============================================================

    @staticmethod
    def summarize(
        organization_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        cash_day_id: Optional[str] = None,
    ) -> dict:
        """Os números do cash no recorte pedido, prontos para o DRE.

        `revenue` é SÓ o rake. `buy_ins`/`cash_outs` viajam junto porque a tela
        os mostra como giro — mas nenhum dos dois entra em receita, e o jackpot
        entra como passivo.
        """
        try:
            if cash_day_id:
                linhas = [l for l in CashReportService.daily(None, None, organization_id)
                          if l["cash_day_id"] == cash_day_id]
            else:
                linhas = CashReportService.daily(date_from, date_to, organization_id)
        except Exception:
            # Rede, RLS, tabela ausente: o DRE de torneio não pode cair por
            # causa de um módulo que este clube talvez nem tenha.
            logger.warning("resumo de cash indisponível; o DRE segue sem ele")
            linhas = []

        pagos = CashReportService._jackpot_pago(
            organization_id, date_from, date_to, cash_day_id
        )
        return {
            "cash_revenue": round(sum(l["revenue"] for l in linhas), 2),
            "cash_jackpot_collected": round(sum(l["jackpot"] for l in linhas), 2),
            "cash_jackpot_paid": round(pagos, 2),
            "cash_buy_ins": round(sum(l["buy_ins"] for l in linhas), 2),
            "cash_cash_outs": round(sum(l["cash_outs"] for l in linhas), 2),
            "cash_days_count": len(linhas),
            "cash_tables_count": sum(l["tables_count"] for l in linhas),
            "cash_players_count": sum(l["players_count"] for l in linhas),
        }

    @staticmethod
    def _jackpot_pago(
        organization_id: Optional[str],
        date_from: Optional[str],
        date_to: Optional[str],
        cash_day_id: Optional[str],
    ) -> float:
        # O `supabase.table(...)` fica DENTRO do try: quando a tabela ainda não
        # foi migrada é ELE que estoura, não o `execute()`. Deixá-lo de fora
        # derrubava o DRE inteiro — foi assim que este bug apareceu.
        try:
            query = supabase.table("cash_jackpot_payouts").select("amount, cash_day_id, paid_at")
            if organization_id:
                query = query.eq("organization_id", organization_id)
            if cash_day_id:
                query = query.eq("cash_day_id", cash_day_id)
            elif date_from or date_to:
                if date_from:
                    query = query.gte("paid_at", date_from)
                if date_to:
                    query = query.lte("paid_at", f"{date_to}T23:59:59")
            linhas = query.execute().data or []
        except Exception:
            # Zero é a resposta honesta: não há pagamento registrado, e o DRE
            # não pode cair por causa de um relatório que ainda não existe.
            logger.warning("pagamentos de jackpot indisponíveis; o DRE segue sem eles")
            return 0.0
        return sum(float(l.get("amount") or 0) for l in linhas)

    # ============================================================
    # Apoio
    # ============================================================

    @staticmethod
    def _dias_no_periodo(
        cash_day_id: Optional[str],
        date_from: Optional[str],
        date_to: Optional[str],
        organization_id: Optional[str],
    ) -> List[str]:
        if cash_day_id:
            return [cash_day_id]
        if not CashReportService._modulo_migrado():
            return []
        query = supabase.table("cash_days").select("id")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if date_from:
            query = query.gte("business_date", date_from)
        if date_to:
            query = query.lte("business_date", date_to)
        return [d["id"] for d in (query.execute().data or [])]

    @staticmethod
    def _horas(inicio, fim) -> float:
        """Horas entre dois instantes. Sem fim = ainda aberto, conta 0.

        Contar até "agora" faria o número mudar a cada refresh da tela, e dois
        operadores veriam relatórios diferentes do mesmo dia.
        """
        if not inicio or not fim:
            return 0.0
        try:
            a = datetime.fromisoformat(str(inicio).replace("Z", "+00:00"))
            b = datetime.fromisoformat(str(fim).replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        return max(0.0, (b - a).total_seconds() / 3600.0)
