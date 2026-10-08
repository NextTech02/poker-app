import logging
from typing import List, Optional
from datetime import datetime, timezone
from collections import defaultdict
import time
from app.database import supabase
# Venda estornada não entregou ficha nenhuma: contá-la infla o chipcount do
# telão com fichas que voltaram para o caixa.
from app.services.transaction_filters import ler_transacoes_ativas
# Recusa de REGRA com codigo. Herda de ValueError, entao todo
# `except ValueError` que ja existe nos routers continua pegando — o que
# muda e a tela receber um `code` para escolher a frase no idioma do clube
# (ver app/utils/erros.py).
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger("uvicorn.error")

# Chipcount cache: {day_id: (timestamp, chipcount)}
# Chipcount only changes on buy-in/rebuy/addon — no need to recompute every 3s poll.
_chipcount_cache: dict = {}
_CHIPCOUNT_TTL = 60  # seconds
from app.models.tournament_day import (
    TournamentDayCreate,
    TournamentDayUpdate,
    TournamentDay,
    TournamentDaySummary,
    TournamentDayDeleteImpact,
    QualifyingDayStats,
    FinalDayAggregatedStats,
    TournamentDayStatus
)
# A medição do estrago é a MESMA do torneio (mesma cascata, uma camada abaixo):
# duplicá-la deixaria as duas guardas divergirem na primeira mudança de regra.
from app.services.tournament_service import (
    MovimentoFinanceiroImpedeExclusao,
    contar_pagantes,
    resumir_vendas,
)
# A regra de ENTRADAS / REENTRADAS / ELIMINACOES dos dois modos (mesa e em
# massa) mora num lugar so — ver app/services/eliminacao.py.
from app.services.eliminacao import (
    COLUNAS_DE_ENTRADA,
    MODO_MESA,
    entradas_para_ativos as _entradas_para_ativos,
    modo_do_torneio,
    reentradas as _reentradas,
    registrar_eliminacao,
)

MSG_DIA_COM_MOVIMENTO = (
    "Este dia tem movimento financeiro e não pode ser excluído. "
    "Cancele as vendas no Caixa (o estorno devolve o dinheiro ao jogador e "
    "acerta o caixa da etapa) antes de excluir."
)

# Status que tiram o jogador do dia: eliminado na mesa, ou com a inscrição
# ESTORNADA (cancelamento de venda — o dinheiro voltou para ele). Nos dois casos
# ele não é sobrevivente: não avança para a final nem entra na contagem de
# classificados que o diretor usa para montar as mesas.
STATUS_FORA_DO_DIA = ("eliminated", "cancelled")



class TournamentDayService:
    # ── Código público de exibição (TV) — POR DIA ───────────────────────────────
    @staticmethod
    def get_or_create_broadcast_code(day_id: str) -> str:
        """Retorna (ou gera) o código curto e único DESTE DIA p/ exibição em TV.
        Cada dia do torneio (Dia 1, Dia 2, Final...) tem o seu próprio código."""
        # `secrets` e não `random`: este código é a credencial que libera a
        # exibição das blinds sem login. O gerador do `random` é previsível a
        # partir de saídas observadas — e os códigos ficam visíveis nas TVs.
        import secrets
        d = supabase.table("tournament_days").select("id, broadcast_code").eq("id", day_id).execute()
        if not d.data:
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado", status=404)
        code = d.data[0].get("broadcast_code")
        if code:
            return code
        alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sem 0/O/1/I/L
        for _ in range(12):
            candidate = "".join(secrets.choice(alphabet) for _ in range(6))
            try:
                supabase.table("tournament_days").update({"broadcast_code": candidate}) \
                    .eq("id", day_id).is_("broadcast_code", "null").execute()
            except Exception:
                continue  # colisão no índice UNIQUE — tenta outro
            cur = supabase.table("tournament_days").select("broadcast_code").eq("id", day_id).execute()
            if cur.data and cur.data[0].get("broadcast_code"):
                return cur.data[0]["broadcast_code"]
        # 409 e nao 404: o dia existe, o que falhou foi achar um codigo livre
        # depois de 12 colisoes no indice UNIQUE. Dizer "nao encontrado"
        # mandava o operador procurar um dia que esta ali.
        raise ErroDeNegocio(
            "codigo_de_tv_nao_gerado",
            "Não foi possível gerar o código",
            status=409,
        )

    @staticmethod
    def resolve_broadcast_code(code: str) -> dict:
        """Resolve o código público → o DIA exato (e seu torneio) a exibir."""
        code = (code or "").strip().upper()
        if not code:
            raise ErroDeNegocio(
                "codigo_de_tv_invalido", "Código inválido", status=404
            )
        d = supabase.table("tournament_days") \
            .select("id, day_name, tournament_id, tournaments(name)") \
            .eq("broadcast_code", code).execute()
        if not d.data:
            raise ErroDeNegocio(
                "codigo_de_tv_invalido", "Código inválido", status=404
            )
        day = d.data[0]
        tour = day.get("tournaments") or {}
        return {
            "tournament_id": day["tournament_id"],
            "tournament_name": tour.get("name"),
            "day_id": day["id"],
            "day_name": day.get("day_name"),
        }

    @staticmethod
    def _sync_tournament_status(tournament_id: str):
        """Sync tournament status based on its days' statuses.
        - Any day active → tournament active
        - All days completed/cancelled (at least one completed) → tournament completed
        - Otherwise → pending
        """
        days_response = supabase.table("tournament_days")\
            .select("status")\
            .eq("tournament_id", tournament_id)\
            .execute()

        days = days_response.data or []
        if not days:
            return

        statuses = [d["status"] for d in days]

        if "active" in statuses:
            new_status = "active"
        elif all(s in ("completed", "cancelled") for s in statuses) and "completed" in statuses:
            new_status = "completed"
        else:
            new_status = "pending"

        supabase.table("tournaments")\
            .update({"status": new_status})\
            .eq("id", tournament_id)\
            .execute()

    @staticmethod
    def create_tournament_day(day_data: TournamentDayCreate) -> TournamentDay:
        """Create a new tournament day"""
        data = {
            **day_data.model_dump(),
            "status": "pending",
            "registered_players": 0,
            "total_entries": 0,
            "prize_pool": 0,
        }

        response = supabase.table("tournament_days").insert(data).execute()
        return TournamentDay(**response.data[0])

    @staticmethod
    def get_tournament_days(
        tournament_id: Optional[str] = None,
        status: Optional[str] = None
    ) -> List[TournamentDay]:
        """Get tournament days, optionally filtered by tournament_id or status"""
        query = supabase.table("tournament_days").select("*")

        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if status:
            statuses = status.split(',')
            query = query.in_("status", statuses)

        rows = query.order("day_number", desc=False).execute().data or []
        if not rows:
            return []

        # total_entries per day in ONE round-trip (was one query per day = N+1).
        entries_by_day, reentries_by_day = TournamentDayService._entries_by_day(
            [r["id"] for r in rows], {r["id"]: r for r in rows}
        )

        days = []
        for item in rows:
            item["total_entries"] = entries_by_day.get(item["id"], 0)
            item["total_reentries"] = reentries_by_day.get(item["id"], 0)
            days.append(TournamentDay(**item))

        return days

    @staticmethod
    def _entries_by_day(day_ids: List[str], dias: Optional[dict] = None) -> tuple:
        """Devolve (entradas_por_dia, reentradas_por_dia) numa consulta so.

        ENTRADA e BUY-IN. So isso. Quem recompra nao entrou de novo no torneio:
        ele voltou para dentro dele, e continua sendo a mesma pessoa disputando
        a mesma vaga. Um torneio com 2 inscritos e 5 recompras tem 2 entradas e
        5 reentradas — nao 7 entradas, que era o que a tela mostrava.

        REENTRADA e so a recompra: o add-on compra fichas, nao traz ninguem de
        volta. O dinheiro das recompras e add-ons continua inteiro na
        premiacao: quem soma arrecadacao e PrizeAllocationService, nao este
        contador.

        Entrada inclui o classificado vindo de outro dia (ver
        `_entradas_para_ativos`); `dias` (por id) deixa o dia final contar os
        que o avanco pelo contador somou sem criar linha."""
        if not day_ids:
            return {}, {}
        players = (
            supabase.table("tournament_players")
            .select(f"tournament_day_id, {COLUNAS_DE_ENTRADA}")
            .in_("tournament_day_id", day_ids)
            .execute()
            .data
            or []
        )
        por_dia = defaultdict(list)
        for p in players:
            por_dia[p["tournament_day_id"]].append(p)
        dias = dias or {}
        agg = {}
        for d in day_ids:
            if d in por_dia or d in dias:
                agg[d] = _entradas_para_ativos(por_dia.get(d, []), dias.get(d))
        reentradas = {d: _reentradas(linhas) for d, linhas in por_dia.items()}
        return agg, reentradas

    @staticmethod
    def get_tournament_day(day_id: str, include_entries: bool = True) -> Optional[TournamentDay]:
        """Get a tournament day by ID.

        `include_entries=False` skips the tournament_players scan used only to
        compute total_entries — for callers that don't need it (e.g. timer
        commands), this avoids a wasteful extra round-trip.
        """
        response = supabase.table("tournament_days").select("*").eq("id", day_id).execute()

        if response.data:
            item = response.data[0]

            total_entries = 0
            total_reentries = 0
            if include_entries:
                linhas = (
                    supabase.table("tournament_players")
                    .select(COLUNAS_DE_ENTRADA)
                    .eq("tournament_day_id", day_id)
                    .execute()
                    .data
                    or []
                )
                # Entrada e buy-in (e o classificado vindo de outro dia). A
                # recompra devolve o jogador ao torneio; ela nao e uma entrada
                # nova. Add-on nao conta em nada. E a mesma conta da TV, para
                # "ENTRADAS − ELIMINACOES = ATIVOS" fechar.
                total_entries = _entradas_para_ativos(linhas, item)
                total_reentries = _reentradas(linhas)

            item["total_entries"] = total_entries
            item["total_reentries"] = total_reentries
            return TournamentDay(**item)
        return None

    @staticmethod
    def get_day_with_stage(day_id: str):
        """Single round-trip validation helper: fetches the day row plus its parent
        tournament's stage_id (via FK embedding), WITHOUT the players sub-query.
        Returns (TournamentDay | None, stage_id | None) so timer endpoints can
        validate existence + stage scoping and reuse the day without re-fetching."""
        response = supabase.table("tournament_days")\
            .select("*, tournaments(stage_id)")\
            .eq("id", day_id)\
            .execute()

        if not response.data:
            return None, None

        row = dict(response.data[0])
        tourn = row.pop("tournaments", None)
        stage_id = tourn.get("stage_id") if isinstance(tourn, dict) else None
        row["total_entries"] = 0
        return TournamentDay(**row), stage_id

    @staticmethod
    def get_tournament_day_summary(
        tournament_id: Optional[str] = None,
        day_id: Optional[str] = None
    ) -> List[TournamentDaySummary]:
        """Tournament-day summaries — single round-trip via the
        `get_tournament_day_summaries` RPC; falls back to the batched query path
        if the RPC isn't deployed yet."""
        try:
            resp = supabase.rpc(
                "get_tournament_day_summaries",
                {"p_tournament_id": tournament_id, "p_day_id": day_id},
            ).execute()
            return [TournamentDaySummary(**row) for row in (resp.data or [])]
        except Exception as exc:
            logger.warning(
                "get_tournament_day_summaries RPC unavailable, using batched fallback: %s", exc
            )
            return TournamentDayService._get_tournament_day_summary_batched(tournament_id, day_id)

    @staticmethod
    def _get_tournament_day_summary_batched(
        tournament_id: Optional[str] = None,
        day_id: Optional[str] = None
    ) -> List[TournamentDaySummary]:
        """Get tournament day summaries with aggregated data"""
        query = supabase.table("tournament_days").select("*")

        if tournament_id:
            query = query.eq("tournament_id", tournament_id)

        if day_id:
            query = query.eq("id", day_id)

        rows = query.order("day_number", desc=False).execute().data or []
        if not rows:
            return []

        # All player stats for all days in ONE round-trip (was N+1), tallied per
        # day in memory with hash maps.
        day_ids = [r["id"] for r in rows]
        players = (
            supabase.table("tournament_players")
            .select("tournament_day_id, buy_in_count, rebuy_count, addon_count")
            .in_("tournament_day_id", day_ids)
            .execute()
            .data
            or []
        )

        buy_ins_by_day = defaultdict(int)
        rebuys_by_day = defaultdict(int)
        addons_by_day = defaultdict(int)
        for p in players:
            d = p["tournament_day_id"]
            buy_ins_by_day[d] += p.get("buy_in_count") or 0
            rebuys_by_day[d] += p.get("rebuy_count") or 0
            addons_by_day[d] += p.get("addon_count") or 0

        summaries = []
        for item in rows:
            did = item["id"]
            total_buy_ins = buy_ins_by_day.get(did, 0)
            total_rebuys = rebuys_by_day.get(did, 0)
            item["total_buy_ins"] = total_buy_ins
            item["total_rebuys"] = total_rebuys
            item["total_addons"] = addons_by_day.get(did, 0)
            # Entrada e buy-in. Recompra e add-on ja vao em total_rebuys e
            # total_addons, e somados em reentradas na tela.
            item["total_entries"] = total_buy_ins
            summaries.append(TournamentDaySummary(**item))

        return summaries

    @staticmethod
    def update_tournament_day(day_id: str, day_data: TournamentDayUpdate) -> Optional[TournamentDay]:
        """Update a tournament day"""
        data = day_data.model_dump(exclude_unset=True)

        # If status is being changed to 'active', set start_time
        if 'status' in data and data['status'] == 'active':
            data['start_time'] = datetime.now(timezone.utc).isoformat()

        try:
            response = (
                supabase.table("tournament_days")
                .update(data)
                .eq("id", day_id)
                .execute()
            )
        except Exception as exc:
            # Tolerate columns that don't exist yet (pre-migration). Strip the
            # unknown column from the payload and retry once.
            msg = str(exc)
            stripped = False
            for col in list(data.keys()):
                if col in msg and "column" in msg.lower():
                    data.pop(col, None)
                    stripped = True
            if not stripped:
                raise
            if data:
                response = (
                    supabase.table("tournament_days")
                    .update(data)
                    .eq("id", day_id)
                    .execute()
                )
            else:
                # Nothing left to update — read the row back so we can return it.
                response = (
                    supabase.table("tournament_days")
                    .select("*")
                    .eq("id", day_id)
                    .execute()
                )

        if response.data:
            day = TournamentDay(**response.data[0])
            # Sync tournament status when day status changes
            if 'status' in data:
                TournamentDayService._sync_tournament_status(day.tournament_id)
            return day
        return None

    @staticmethod
    def get_delete_impact(day_id: str) -> Optional[TournamentDayDeleteImpact]:
        """Mede o estrago da exclusão DESTE DIA antes de executá-la.

        `transactions` não guarda o dia: a venda aponta para a INSCRIÇÃO
        (`tournament_player_id`), e é ela que sabe o dia. Por isso o caminho é
        inscrições do dia → vendas dessas inscrições. Venda antiga sem inscrição
        vinculada não é atribuída a dia nenhum — para essas, quem segura a
        exclusão é a guarda do TORNEIO.

        PREMIAÇÃO PAGA entra por um caminho próprio: o pagamento de prêmio não
        aponta para inscrição nenhuma (só para torneio e jogador), e no dia
        final os classificados entram sem pagar nada (total_spent zero). Só
        pelas vendas, o dia que decidiu o torneio pareceria vazio e a exclusão
        apagaria o registro de quem ganhou. Por isso o prêmio é atribuído ao dia
        pelo JOGADOR: conta aqui o prêmio pago a alguém INSCRITO neste dia.
        Medir pelo torneio inteiro, como já se fez, travava TODOS os dias de uma
        vez — inclusive um dia vazio criado por engano, que ficava sem saída
        nenhuma pela tela, mandando cancelar vendas que ele não tem.
        """
        dia = (
            supabase.table("tournament_days").select("id, tournament_id, day_name")
            .eq("id", day_id).execute()
        )
        if not dia.data:
            return None
        linha = dia.data[0]

        inscricoes = (
            supabase.table("tournament_players")
            .select("id, player_id, status, total_spent")
            .eq("tournament_day_id", day_id).execute().data or []
        )
        vendas = {}
        if inscricoes:
            vendas = {
                v["id"]: v for v in (
                    supabase.table("transactions").select("*")
                    .in_("tournament_player_id", [i["id"] for i in inscricoes])
                    .execute().data or []
                )
            }
            jogadores_do_dia = sorted(
                {i["player_id"] for i in inscricoes if i.get("player_id")}
            )
            if jogadores_do_dia:
                for premio in (
                    supabase.table("transactions").select("*")
                    .eq("tournament_id", linha.get("tournament_id"))
                    .eq("type", "prize")
                    .in_("player_id", jogadores_do_dia).execute().data or []
                ):
                    vendas.setdefault(premio["id"], premio)

        resumo = resumir_vendas(list(vendas.values()))
        pagantes = contar_pagantes(inscricoes)
        return TournamentDayDeleteImpact(
            day_id=day_id,
            day_name=linha.get("day_name") or "",
            tournament_id=linha.get("tournament_id") or "",
            players=len(inscricoes),
            paying_players=pagantes,
            blocked=bool(resumo["entries"] or resumo["prizes"] or pagantes),
            **resumo,
        )

    @staticmethod
    def delete_tournament_day(day_id: str) -> bool:
        """Apaga o dia — RECUSANDO quando ainda há dinheiro em cima.

        Mesmo buraco da exclusão de torneio, uma camada abaixo: a FK de
        `tournament_players` para `tournament_days` é ON DELETE CASCADE, então
        apagar o dia leva as inscrições daquele dia e, com elas, as vendas.
        Nada estorna o caixa da etapa — ele fica apontando dinheiro sem origem.

        A tela só oferece o botão em dia 'pending', mas isso é conforto, não
        garantia: a regra precisa valer para quem chama a API direto.
        """
        impacto = TournamentDayService.get_delete_impact(day_id)
        if impacto is None:
            return False
        if impacto.blocked:
            raise MovimentoFinanceiroImpedeExclusao(impacto, MSG_DIA_COM_MOVIMENTO)

        response = supabase.table("tournament_days").delete().eq("id", day_id).execute()
        return len(response.data) > 0

    @staticmethod
    def get_days_by_tournament(tournament_id: str) -> List[TournamentDay]:
        """Get all days for a specific tournament, ordered by day_number"""
        return TournamentDayService.get_tournament_days(tournament_id=tournament_id)

    @staticmethod
    def get_survivors(day_id: str) -> List[dict]:
        """Jogadores do dia que ainda estão vivos (sobreviventes).

        Fora 'eliminated', fica de fora 'cancelled': a inscrição estornada
        devolveu o dinheiro ao jogador. Tratá-lo como sobrevivente o levaria ao
        dia final com stack, ocupando vaga e disputando a premiação — e ainda
        obrigaria o operador a digitar as fichas de alguém que não está no
        evento. Dois `neq` em vez de `not_.in_` porque é o mesmo filtro para o
        PostgREST e não depende de embed.
        """
        response = supabase.table("tournament_players")\
            .select("*, players(name, nickname)")\
            .eq("tournament_day_id", day_id)\
            .neq("status", "eliminated")\
            .neq("status", "cancelled")\
            .execute()

        return response.data if response.data else []

    @staticmethod
    def _fichas_vendidas_por_jogador(inscritos: List[dict]) -> dict:
        """Fichas que as vendas ATIVAS entregaram, por inscrito.

        Devolve {tp_id: {"buy_in": (fichas, coberto), ...}}, onde `coberto` diz
        quantas unidades do contador aquela soma já explica — é isso que evita
        contar a mesma recompra duas vezes lá em cima.

        UMA consulta para todos os inscritos, de propósito: perguntar as vendas
        de cada jogador dentro do laço é o N+1 que já derrubou o desempenho
        deste projeto antes, e um dia final tem centenas de linhas.

        Banco ainda sem a coluna `chips` (o deploy não é atômico com a
        migração): a consulta falha, devolvemos vazio e o chamador cai na
        multiplicação de sempre. Melhor um número teórico do que um 500 no meio
        do evento.
        """
        ids = [i["id"] for i in inscritos if i.get("id")]
        if not ids:
            return {}
        try:
            linhas = ler_transacoes_ativas(
                lambda colunas: (
                    supabase.table("transactions")
                    .select(colunas)
                    .in_("tournament_player_id", ids)
                    .in_("type", ["buy_in", "rebuy", "addon"])
                ),
                "tournament_player_id, type, chips",
            )
        except Exception:
            logger.warning(
                "não consegui ler as fichas das vendas; caindo na multiplicação "
                "pelos contadores do dia", exc_info=True,
            )
            return {}

        por_jogador: dict = {}
        for linha in linhas:
            fichas = linha.get("chips")
            if fichas is None:
                # Venda anterior à migração: não sabemos quantas fichas ela
                # entregou, então ela fica de fora e o contador dela continua
                # sendo multiplicado pelo campo do dia — o que já era feito.
                continue
            do_jogador = por_jogador.setdefault(linha.get("tournament_player_id"), {})
            somado, coberto = do_jogador.get(linha.get("type"), (0, 0))
            # O buy-in é UMA linha para a inscrição inteira (buy_in_count pode
            # ser 2), então ela cobre o contador todo; recompra e add-on são uma
            # linha por unidade.
            do_jogador[linha.get("type")] = (somado + int(fichas), coberto + 1)
        return por_jogador

    @staticmethod
    def _entradas_do_dia(day) -> tuple:
        """Entradas e fichas concedidas no dia (buy-in/rebuy/add-on).

        É o número que o clube usa quando não conta ficha por jogador: serve de
        referência e alimenta o caminho antigo do avanço.
        Devolve (total_chips, total_entries, total_reentradas).

        As FICHAS vêm das VENDAS, não de contador vezes campo do dia. Desde os
        meios de entrada por dia, uma "recompra dupla" entrega uma pilha própria
        — multiplicar `rebuy_chips` pelo número de recompras passaria a MENTIR o
        chipcount do telão, que é o que decide o stack médio na tela.

        A multiplicação continua valendo para o que as vendas não explicam:
        vendas antigas (sem `chips` gravado) e inscritos criados sem transação
        nenhuma — os classificados que o avanço traz do dia anterior.

        As ENTRADAS, não: entrada e buy-in. Quem recompra voltou para o torneio,
        nao entrou nele de novo.
        """
        players_response = supabase.table("tournament_players")\
            .select("id, buy_in_count, rebuy_count, addon_count")\
            .eq("tournament_day_id", day.id)\
            .execute()
        inscritos = players_response.data or []
        vendidas = TournamentDayService._fichas_vendidas_por_jogador(inscritos)

        padrao = {
            "buy_in": day.starting_chips or 0,
            "rebuy": day.rebuy_chips or 0,
            "addon": day.addon_chips or 0,
        }
        total_chips = 0
        total_entries = 0
        total_reentradas = 0
        for p in inscritos:
            contadores = {
                "buy_in": p.get("buy_in_count", 0) or 0,
                "rebuy": p.get("rebuy_count", 0) or 0,
                "addon": p.get("addon_count", 0) or 0,
            }
            do_jogador = vendidas.get(p.get("id"), {})
            for tipo, quantas in contadores.items():
                somado, coberto = do_jogador.get(tipo, (0, 0))
                # O buy-in de uma linha só cobre a inscrição inteira; nas outras
                # categorias sobra o que não tem venda com fichas gravadas.
                if tipo == "buy_in" and coberto:
                    coberto = quantas
                total_chips += somado + max(0, quantas - coberto) * padrao[tipo]
            total_entries += contadores["buy_in"]
            total_reentradas += contadores["rebuy"]
        return total_chips, total_entries, total_reentradas

    @staticmethod
    def advance_qualifiers(qualifying_day_id: str) -> dict:
        """
        Avança os sobreviventes de um dia classificatório para o dia final.

        Caminho principal (há jogadores registrados um a um no dia): cria a
        linha de cada classificado dentro do dia final, com o stack REAL que ele
        levou da mesa (final_chip_count). É isso que faz o telão e o controle do
        dia final terem de onde tirar o chipcount — sem essas linhas, o dia
        final existe só como contador.

        Caminho antigo (nenhum jogador individual no dia): mantém a soma de
        contadores, para o clube que opera só com o contador de eliminações.
        """
        # Get the qualifying day
        qualifying_day = TournamentDayService.get_tournament_day(qualifying_day_id)
        if not qualifying_day:
            raise ErroDeNegocio(
                "dia_classificatorio_nao_encontrado",
                "Dia classificatório não encontrado",
                status=404,
            )

        if qualifying_day.day_type != "qualifying":
            raise ErroDeNegocio(
                "dia_nao_e_classificatorio", "Este dia não é um dia classificatório"
            )

        if not qualifying_day.qualifies_to_day_id:
            raise ErroDeNegocio(
                "dia_sem_final_vinculada", "Este dia não tem um dia final vinculado"
            )

        # Get the final day
        final_day = TournamentDayService.get_tournament_day(qualifying_day.qualifies_to_day_id)
        if not final_day:
            raise ErroDeNegocio(
                "dia_final_nao_encontrado", "Dia final não encontrado", status=404
            )

        sobreviventes = TournamentDayService.get_survivors(qualifying_day_id)
        # A coluna final_chip_count pode não existir num banco ainda não migrado.
        # Nesse caso NENHUMA linha traz a chave, e exigir as fichas travaria o
        # avanço de quem já opera hoje — então cai no caminho antigo.
        tem_coluna_de_fichas = any("final_chip_count" in s for s in sobreviventes)

        # Ter linhas de jogador NÃO significa que o clube controla a eliminação
        # jogador a jogador: muitos registram cada entrada no Caixa mas marcam a
        # saída no CONTADOR genérico do dia. Nesses dias todo inscrito continua
        # 'active', e exigir o stack de "todos os sobreviventes" cobraria fichas
        # de gente eliminada há horas — o avanço travaria no meio do evento
        # ("87 de 90 sem fichas registradas") e o dia final não abriria.
        # Por isso o caminho por jogador só vale com EVIDÊNCIA desse fluxo:
        #   * alguém já teve as fichas contadas na tela de classificados, OU
        #   * o contador de eliminações bate com a lista (as eliminações foram
        #     mesmo lançadas jogador a jogador).
        alguma_ficha_contada = any(
            s.get("final_chip_count") is not None for s in sobreviventes
        )
        contador_bate = (
            TournamentDayService._sobreviventes_pelo_contador(qualifying_day)
            == len(sobreviventes)
        )
        usa_fluxo_por_jogador = alguma_ficha_contada or contador_bate
        # No modo MESA nao ha o que adivinhar: o diretor elimina jogador a
        # jogador, a lista de sobreviventes e a verdade. A heuristica acima
        # continua valendo so para o modo em massa.
        if modo_do_torneio(qualifying_day.tournament_id, supabase) == MODO_MESA:
            usa_fluxo_por_jogador = True

        if sobreviventes and tem_coluna_de_fichas and usa_fluxo_por_jogador:
            return TournamentDayService._avancar_por_jogador(
                qualifying_day, final_day, sobreviventes
            )

        return TournamentDayService._avancar_por_contador(qualifying_day, final_day)

    @staticmethod
    def _sobreviventes_pelo_contador(day) -> int:
        """Quantos sobreviventes o CONTADOR genérico do dia diz que existem."""
        return max(
            0,
            (day.registered_players or 0)
            - (getattr(day, "eliminations_count", 0) or 0),
        )

    @staticmethod
    def _avancar_por_contador(qualifying_day, final_day) -> dict:
        """Avanço pelo contador genérico de eliminações (sem jogador a jogador).

        Aqui nenhuma linha é criada no dia final, então nenhum trigger de banco
        mexe em registered_players — por isso este caminho ainda soma o contador
        na mão.
        """
        eliminations_count = qualifying_day.eliminations_count if hasattr(qualifying_day, 'eliminations_count') and qualifying_day.eliminations_count else 0
        registered = qualifying_day.registered_players or 0
        survivors_count = max(0, registered - eliminations_count)

        if survivors_count <= 0:
            raise ErroDeNegocio(
                "sem_sobreviventes_para_avancar",
                "Nenhum sobrevivente para avançar (todos eliminados)",
            )

        total_chips, total_entries, _ = TournamentDayService._entradas_do_dia(qualifying_day)

        # Carry over prize pool
        qualifying_prize_pool = qualifying_day.prize_pool or 0
        final_prize_pool = final_day.prize_pool or 0
        final_registered = final_day.registered_players or 0
        final_entries = final_day.total_entries or 0

        supabase.table("tournament_days")\
            .update({
                "registered_players": final_registered + survivors_count,
                "total_entries": final_entries + total_entries,
                "prize_pool": final_prize_pool + qualifying_prize_pool
            })\
            .eq("id", final_day.id)\
            .execute()

        _chipcount_cache.pop(final_day.id, None)

        return {
            "advanced_count": survivors_count,
            "final_day_id": final_day.id,
            "final_day_name": final_day.day_name,
            "total_chips": total_chips,
            "total_entries": total_entries,
            "players": [],
        }

    @staticmethod
    def _jogadores_ja_no_dia_final(final_day_id) -> set:
        """Quem já tem linha no dia final — não pode entrar de novo.

        Filtra por jogador (e não só pelo dia de origem) porque um clique
        repetido em "Avançar" e um buy-in direto na final produziriam a mesma
        duplicata.
        """
        ja_no_dia_final = set()
        existentes = supabase.table("tournament_players")\
            .select("player_id")\
            .eq("tournament_day_id", final_day_id)\
            .execute()
        for r in (existentes.data or []):
            if r.get("player_id"):
                ja_no_dia_final.add(r["player_id"])
        return ja_no_dia_final

    @staticmethod
    def _avancar_por_jogador(qualifying_day, final_day, sobreviventes: List[dict]) -> dict:
        """Cria no dia final uma linha por classificado, carregando o stack real."""
        # O contador genérico de eliminações e a lista por jogador podem
        # discordar (alguém eliminado no contador mas sem status atualizado, ou
        # vice-versa). Quem manda é a lista por jogador — mas a divergência vira
        # log, porque é o sintoma de contador de eliminações mal operado.
        pelo_contador = TournamentDayService._sobreviventes_pelo_contador(qualifying_day)
        if pelo_contador != len(sobreviventes):
            logger.warning(
                "advance_qualifiers dia %s: contador diz %s sobreviventes, "
                "lista por jogador diz %s — vale a lista por jogador",
                qualifying_day.id, pelo_contador, len(sobreviventes),
            )

        sem_fichas = [
            s for s in sobreviventes
            if not s.get("final_chip_count") or int(s["final_chip_count"]) <= 0
        ]
        if sem_fichas:
            # Avançar sem as fichas contadas produziria um dia final com stacks
            # zerados — o erro tem que aparecer ANTES de criar as linhas.
            # Os dois numeros vao TAMBEM como dado nomeado: a tela remonta
            # "2 de 5" no idioma dela sem depender da frase pronta.
            raise ErroDeNegocio(
                "fichas_dos_classificados_faltando",
                f"Registre as fichas de todos os classificados antes de avançar "
                f"({len(sem_fichas)} de {len(sobreviventes)} sem fichas registradas)",
                sem_fichas=len(sem_fichas),
                total=len(sobreviventes),
            )

        # Idempotência: quem já tem linha no dia final não entra de novo.
        ja_no_dia_final = TournamentDayService._jogadores_ja_no_dia_final(final_day.id)

        linhas = []
        avancados = []
        for s in sobreviventes:
            player_id = s.get("player_id")
            if not player_id or player_id in ja_no_dia_final:
                continue
            fichas = int(s["final_chip_count"])
            linhas.append({
                "tournament_id": final_day.tournament_id,
                "tournament_day_id": final_day.id,
                "player_id": player_id,
                # Classificado não paga entrada de novo: buy_in_count=0 mantém o
                # financeiro do dia final limpo (a entrada já foi cobrada no
                # classificatório).
                "buy_in_count": 0,
                "total_buy_in_amount": 0,
                "rebuy_count": 0,
                "addon_count": 0,
                "total_chips": fichas,
                "status": "active",
                "is_qualified_entry": True,
                "qualified_from_day_id": qualifying_day.id,
            })
            avancados.append({
                "player_id": player_id,
                "player_name": (s.get("players") or {}).get("name"),
                "chips": fichas,
            })

        _, total_entries, _ = TournamentDayService._entradas_do_dia(qualifying_day)

        # Lido ANTES do insert de propósito: no banco, o trigger de prize_pool
        # dispara a cada linha nova e recalcula o prêmio do dia final a partir
        # das transações dele — o que apagaria o valor herdado do
        # classificatório se fôssemos reler depois.
        qualifying_prize_pool = qualifying_day.prize_pool or 0
        final_prize_pool = final_day.prize_pool or 0
        final_entries = final_day.total_entries or 0

        if linhas:
            supabase.table("tournament_players").insert(linhas).execute()

            # registered_players NÃO entra aqui: o trigger
            # update_tournament_player_count já soma 1 por linha inserida.
            # Somar de novo mostraria o dobro de inscritos no dia final.
            supabase.table("tournament_days")\
                .update({
                    "total_entries": final_entries + total_entries,
                    "prize_pool": final_prize_pool + qualifying_prize_pool,
                })\
                .eq("id", final_day.id)\
                .execute()

        # A TV lê o chipcount de um cache de 60s; sem limpar, o dia final
        # apareceria vazio na tela depois do avanço.
        _chipcount_cache.pop(final_day.id, None)
        _chipcount_cache.pop(qualifying_day.id, None)

        return {
            "advanced_count": len(avancados),
            "final_day_id": final_day.id,
            "final_day_name": final_day.day_name,
            # Fichas REAIS que entram na final, não a soma teórica concedida.
            "total_chips": sum(a["chips"] for a in avancados),
            "total_entries": total_entries,
            "players": avancados,
        }

    @staticmethod
    def update_player_chips(day_id: str, player_id: str, chip_count: int) -> bool:
        """Update the final chip count for a player in a day"""
        response = supabase.table("tournament_players")\
            .update({"final_chip_count": chip_count})\
            .eq("tournament_day_id", day_id)\
            .eq("player_id", player_id)\
            .execute()

        return len(response.data) > 0 if response.data else False

    @staticmethod
    def bulk_update_chips(day_id: str, chip_updates: List[dict]) -> int:
        """
        Bulk update chip counts for multiple players.
        chip_updates: list of {"player_id": str, "chip_count": int}
        Returns number of players updated.

        Prefere a RPC `bulk_update_chip_counts` (UPDATE set-based, 1 round-trip).
        Cai para o loop por jogador (N round-trips) se a RPC não estiver no banco.
        """
        if not chip_updates:
            return 0

        player_ids = [u["player_id"] for u in chip_updates]
        chips = [int(u["chip_count"]) for u in chip_updates]
        try:
            resp = supabase.rpc("bulk_update_chip_counts", {
                "p_day_id": day_id,
                "p_player_ids": player_ids,
                "p_chips": chips,
            }).execute()
            _chipcount_cache.pop(day_id, None)
            return resp.data if isinstance(resp.data, int) else (resp.data or 0)
        except Exception:
            updated_count = 0
            for update in chip_updates:
                if TournamentDayService.update_player_chips(
                    day_id, update["player_id"], update["chip_count"]
                ):
                    updated_count += 1
            _chipcount_cache.pop(day_id, None)
            return updated_count

    @staticmethod
    def get_final_day_aggregated_stats(final_day_id: str) -> FinalDayAggregatedStats:
        """
        Get aggregated statistics for a final day including all qualifying days.

        Returns comprehensive stats showing:
        - Per-qualifying-day breakdown
        - Total aggregated stats from all qualifying days
        - Final day specific stats (direct entries)
        - Combined totals
        """
        # Get the final day
        final_day = TournamentDayService.get_tournament_day(final_day_id)
        if not final_day:
            raise ErroDeNegocio(
                "dia_final_nao_encontrado", "Dia final não encontrado", status=404
            )

        # Get all qualifying days that point to this final day
        qualifying_days_response = supabase.table("tournament_days")\
            .select("*")\
            .eq("qualifies_to_day_id", final_day_id)\
            .order("day_number")\
            .execute()

        qualifying_days_stats = []
        total_qualifying_buy_ins = 0
        total_qualifying_rebuys = 0
        total_qualifying_addons = 0
        total_qualifying_buy_in_amount = 0.0
        total_qualifying_rebuy_amount = 0.0
        total_qualifying_addon_amount = 0.0
        total_qualifying_prize_pool = 0.0

        # Busca os jogadores de TODOS os dias classificatórios numa só query e
        # agrupa por dia (antes era 1 query por dia = N+1 round-trips).
        q_day_ids = [q["id"] for q in (qualifying_days_response.data or [])]
        players_by_day = {}
        if q_day_ids:
            all_q_players = supabase.table("tournament_players")\
                .select("*")\
                .in_("tournament_day_id", q_day_ids)\
                .execute()
            for p in (all_q_players.data or []):
                players_by_day.setdefault(p.get("tournament_day_id"), []).append(p)

        for q_day in (qualifying_days_response.data or []):
            players = players_by_day.get(q_day["id"], [])

            # Calculate stats for this qualifying day
            day_buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in players)
            day_rebuys = sum(p.get("rebuy_count", 0) or 0 for p in players)
            day_addons = sum(p.get("addon_count", 0) or 0 for p in players)
            day_buy_in_amount = sum(float(p.get("total_buy_in_amount", 0) or 0) for p in players)
            day_rebuy_amount = sum(float(p.get("total_rebuy_amount", 0) or 0) for p in players)
            day_addon_amount = sum(float(p.get("total_addon_amount", 0) or 0) for p in players)

            eliminated = len([p for p in players if p.get("status") == "eliminated"])
            qualified = len([p for p in players if p.get("status") not in STATUS_FORA_DO_DIA])

            day_stats = QualifyingDayStats(
                day_id=q_day["id"],
                day_name=q_day["day_name"],
                day_number=q_day["day_number"],
                status=TournamentDayStatus(q_day["status"]),
                total_players=len(players),
                eliminated_players=eliminated,
                qualified_players=qualified,
                total_buy_ins=day_buy_ins,
                total_rebuys=day_rebuys,
                total_addons=day_addons,
                # Entrada e buy-in; a recompra ja vai em total_rebuys.
                total_entries=day_buy_ins,
                buy_in_amount=day_buy_in_amount,
                rebuy_amount=day_rebuy_amount,
                addon_amount=day_addon_amount,
                total_collected=day_buy_in_amount + day_rebuy_amount + day_addon_amount,
                prize_pool=float(q_day.get("prize_pool", 0) or 0)
            )
            qualifying_days_stats.append(day_stats)

            # Accumulate totals
            total_qualifying_buy_ins += day_buy_ins
            total_qualifying_rebuys += day_rebuys
            total_qualifying_addons += day_addons
            total_qualifying_buy_in_amount += day_buy_in_amount
            total_qualifying_rebuy_amount += day_rebuy_amount
            total_qualifying_addon_amount += day_addon_amount
            total_qualifying_prize_pool += float(q_day.get("prize_pool", 0) or 0)

        # Get final day players and calculate stats
        final_players_response = supabase.table("tournament_players")\
            .select("*")\
            .eq("tournament_day_id", final_day_id)\
            .execute()

        final_players = final_players_response.data or []

        # Separate qualified vs direct buy-in players
        qualified_players = [p for p in final_players if p.get("is_qualified_entry")]
        direct_players = [p for p in final_players if not p.get("is_qualified_entry")]

        # Calculate final day specific stats (only from direct entries, not carried over)
        # For direct entries, count their entries
        final_day_buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in direct_players)
        final_day_rebuys = sum(p.get("rebuy_count", 0) or 0 for p in final_players)  # All rebuys in final day
        final_day_addons = sum(p.get("addon_count", 0) or 0 for p in final_players)  # All addons in final day

        # For direct players, calculate collected amounts in final day
        final_day_collected = (
            sum(float(p.get("total_buy_in_amount", 0) or 0) for p in direct_players) +
            sum(float(p.get("total_rebuy_amount", 0) or 0) for p in final_players) +
            sum(float(p.get("total_addon_amount", 0) or 0) for p in final_players)
        )

        total_qualifying_collected = total_qualifying_buy_in_amount + total_qualifying_rebuy_amount + total_qualifying_addon_amount

        return FinalDayAggregatedStats(
            final_day_id=final_day_id,
            final_day_name=final_day.day_name,
            total_qualified_players=len(qualified_players),
            direct_buy_in_players=len(direct_players),
            total_players=len(final_players),
            qualifying_days=qualifying_days_stats,
            total_qualifying_buy_ins=total_qualifying_buy_ins,
            total_qualifying_rebuys=total_qualifying_rebuys,
            total_qualifying_addons=total_qualifying_addons,
            total_qualifying_entries=total_qualifying_buy_ins,
            total_qualifying_buy_in_amount=total_qualifying_buy_in_amount,
            total_qualifying_rebuy_amount=total_qualifying_rebuy_amount,
            total_qualifying_addon_amount=total_qualifying_addon_amount,
            total_qualifying_collected=total_qualifying_collected,
            total_qualifying_prize_pool=total_qualifying_prize_pool,
            final_day_buy_ins=final_day_buy_ins,
            final_day_rebuys=final_day_rebuys,
            final_day_addons=final_day_addons,
            final_day_collected=final_day_collected,
            combined_prize_pool=float(final_day.prize_pool or 0),
            combined_total_collected=total_qualifying_collected + final_day_collected
        )

    @staticmethod
    def get_qualifying_day_stats(day_id: str) -> QualifyingDayStats:
        """Get detailed statistics for a single qualifying day"""
        day = TournamentDayService.get_tournament_day(day_id)
        if not day:
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado", status=404)

        # Get all players for this day
        players_response = supabase.table("tournament_players")\
            .select("*")\
            .eq("tournament_day_id", day_id)\
            .execute()

        players = players_response.data or []

        # Calculate stats
        buy_ins = sum(p.get("buy_in_count", 0) or 0 for p in players)
        rebuys = sum(p.get("rebuy_count", 0) or 0 for p in players)
        addons = sum(p.get("addon_count", 0) or 0 for p in players)
        buy_in_amount = sum(float(p.get("total_buy_in_amount", 0) or 0) for p in players)
        rebuy_amount = sum(float(p.get("total_rebuy_amount", 0) or 0) for p in players)
        addon_amount = sum(float(p.get("total_addon_amount", 0) or 0) for p in players)

        eliminated = len([p for p in players if p.get("status") == "eliminated"])
        qualified = len([p for p in players if p.get("status") not in STATUS_FORA_DO_DIA])

        return QualifyingDayStats(
            day_id=day_id,
            day_name=day.day_name,
            day_number=day.day_number,
            status=day.status,
            total_players=len(players),
            eliminated_players=eliminated,
            qualified_players=qualified,
            total_buy_ins=buy_ins,
            total_rebuys=rebuys,
            total_addons=addons,
            # Entrada e buy-in; a recompra ja vai em total_rebuys.
            total_entries=buy_ins,
            buy_in_amount=buy_in_amount,
            rebuy_amount=rebuy_amount,
            addon_amount=addon_amount,
            total_collected=buy_in_amount + rebuy_amount + addon_amount,
            prize_pool=float(day.prize_pool or 0)
        )

    # ================================================
    # Timer Control Methods
    # ================================================

    @staticmethod
    def start_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Start or resume tournament timer. `day` may be passed pre-fetched
        (e.g. from the router validation) to avoid an extra round-trip."""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        was_active = day.status == "active"

        # Update timer state
        response = supabase.table("tournament_days")\
            .update({
                "is_paused": False,
                "timer_started_at": datetime.now(timezone.utc).isoformat(),
                "status": "active"
            })\
            .eq("id", day_id)\
            .execute()

        # Sync tournament status only on the pending→active transition. On a resume
        # (pause keeps status='active') the tournament is already active, so we skip
        # the 2 extra round-trips of _sync_tournament_status.
        if response.data and not was_active:
            TournamentDayService._sync_tournament_status(day.tournament_id)

        return response.data[0] if response.data else None

    @staticmethod
    def pause_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Pause tournament timer"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        # Calculate current elapsed time
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            new_elapsed_time = day.elapsed_time + round(time_since_start)
        else:
            new_elapsed_time = day.elapsed_time

        # Update timer state
        response = supabase.table("tournament_days")\
            .update({
                "is_paused": True,
                "elapsed_time": new_elapsed_time,
                "timer_started_at": None
            })\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def adjust_timer(day_id: str, seconds: int, day: Optional[TournamentDay] = None):
        """Manually adjust remaining time. Positive = add time (subtract elapsed), negative = remove time (add elapsed)"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        # If timer is running, materialize the current elapsed time
        current_elapsed = day.elapsed_time or 0
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed += round(time_since_start)

        # Adjust: positive seconds = add remaining time = subtract elapsed
        new_elapsed_time = max(0, current_elapsed - seconds)
        new_adjustment = (day.manual_time_adjustment or 0) + seconds

        update_data = {
            "manual_time_adjustment": new_adjustment,
            "elapsed_time": new_elapsed_time,
        }
        # Reset timer_started_at if running so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def set_level(day_id: str, level: int):
        """Set current blind level"""
        day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        if level < 1:
            raise ErroDeNegocio(
                "nivel_minimo_de_blind", "Level must be at least 1", minimo=1
            )

        response = supabase.table("tournament_days")\
            .update({"current_level": level})\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def next_level(day_id: str, day: Optional[TournamentDay] = None):
        """Advance to next blind level - sync elapsed_time to start of new level"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        new_level = day.current_level + 1
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate elapsed_time that corresponds to the START of the new level
        new_elapsed = TournamentDayService._sum_durations_before_level(blinds, new_level)

        update_data = {
            "current_level": new_level,
            "elapsed_time": new_elapsed,
        }
        # If timer is running, reset timer_started_at to now so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def previous_level(day_id: str, day: Optional[TournamentDay] = None):
        """Go back to previous blind level - sync elapsed_time to start of that level"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        new_level = max(1, day.current_level - 1)
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate elapsed_time that corresponds to the START of the target level
        new_elapsed = TournamentDayService._sum_durations_before_level(blinds, new_level)

        update_data = {
            "current_level": new_level,
            "elapsed_time": new_elapsed,
        }
        # If timer is running, reset timer_started_at to now so elapsed continues from new base
        if day.timer_started_at and not day.is_paused:
            update_data["timer_started_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("tournament_days")\
            .update(update_data)\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def reset_timer(day_id: str, day: Optional[TournamentDay] = None):
        """Reset timer to 00:00 and pause"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        response = supabase.table("tournament_days")\
            .update({
                "elapsed_time": 0,
                "manual_time_adjustment": 0,
                "is_paused": True,
                "timer_started_at": None,
                "current_level": 1
            })\
            .eq("id", day_id)\
            .execute()

        return response.data[0] if response.data else None

    @staticmethod
    def get_timer_status(day_id: str, day: Optional[TournamentDay] = None):
        """Get current timer status with player counts"""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        # One players scan feeds both active count and total_entries (so we don't
        # depend on day.total_entries — the day may be fetched without that scan)
        players_response = supabase.table("tournament_players")\
            .select(COLUNAS_DE_ENTRADA)\
            .eq("tournament_day_id", day_id)\
            .execute()

        rows = players_response.data or []
        # A MESMA conta da TV e do Controle: ATIVOS = ENTRADAS − ELIMINACOES.
        # Contar status 'active' errava duas vezes: o inscrito novo nasce
        # 'registered', e no modo em massa ninguem muda de status ao sair.
        total_entries = _entradas_para_ativos(rows, day)
        active_players = max(0, total_entries - (getattr(day, "eliminations_count", 0) or 0))

        # Calculate current elapsed time if timer is running
        current_elapsed = day.elapsed_time
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed = day.elapsed_time + round(time_since_start)

        from app.models.tournament_day import TimerStatus
        return TimerStatus(
            day_id=day_id,
            current_level=day.current_level or 1,
            elapsed_time=current_elapsed,
            is_paused=day.is_paused or False,
            timer_started_at=day.timer_started_at,
            manual_time_adjustment=day.manual_time_adjustment or 0,
            active_players=active_players,
            total_entries=total_entries
        )

    # ================================================
    # Helper Methods for Enriched Timer Status
    # ================================================

    @staticmethod
    def _get_all_blinds(day_id: str, tournament_id: str) -> list:
        """Get all blinds for a tournament day (day-specific or tournament-level)"""
        # Try to get day-specific blinds first
        blinds_response = supabase.table("blinds")\
            .select("*")\
            .eq("tournament_day_id", day_id)\
            .order("level")\
            .execute()

        blinds = blinds_response.data

        # If no day-specific blinds, get tournament blinds.
        # Só as linhas LEGADAS (sem dia), porque todo blind criado por dia
        # também grava o tournament_id: sem esse recorte, um dia com a
        # estrutura vazia passaria a exibir no telão os blinds de OUTRO dia do
        # mesmo torneio — errado e sem ninguém perceber.
        if not blinds or len(blinds) == 0:
            blinds_response = supabase.table("blinds")\
                .select("*")\
                .eq("tournament_id", tournament_id)\
                .is_("tournament_day_id", "null")\
                .order("level")\
                .execute()
            blinds = blinds_response.data

        return blinds if blinds else []

    @staticmethod
    def _find_blind_by_level(blinds: list, level: int) -> dict:
        """Find a specific blind level in the blinds list"""
        for blind in blinds:
            if blind["level"] == level:
                return blind
        return None

    @staticmethod
    def _proximo_blind(blinds: list, nivel_atual: int) -> Optional[dict]:
        """O PRÓXIMO nível da estrutura — o seguinte na ordem, não o `atual + 1`.

        A numeração tem buracos na vida real: apagar um nível ou um intervalo no
        meio deixa 2 → 4, 5 → 7. Procurar `atual + 1` não achava nada nesses
        pontos, e o telão anunciava "PRÓXIMOS BLINDS 0/0 (0)" para a mesa
        inteira — o operador via zero e não tinha como saber o que vinha.

        `blinds` chega ordenado por nível (é o `.order("level")` de quem lê),
        mas o mínimo é calculado explicitamente: uma lista fora de ordem daria
        o nível errado em silêncio, e este número está numa TV.
        """
        seguintes = [b for b in blinds if b.get("level") is not None and b["level"] > nivel_atual]
        return min(seguintes, key=lambda b: b["level"]) if seguintes else None

    @staticmethod
    def _numero_exibido(blinds: list, level: Optional[int]) -> Optional[int]:
        """O número que a TV e o controle MOSTRAM para uma posição da estrutura.

        `level` no banco é posição: o intervalo ocupa uma (1, 2, ..., INTERVALO=7,
        8...). Mas intervalo não é nível de jogo — a tela de blinds renumera
        pulando os intervalos, e o telão mostrava a posição crua: 800/1600 era
        "Nível 9" na estrutura e "NÍVEL 10" na TV, e a diferença crescia a cada
        intervalo. Conta só os níveis de jogo até esta posição (inclusive); para
        um intervalo, é o número do último nível jogado.
        """
        if level is None:
            return None
        return sum(
            1 for b in blinds
            if b.get("level") is not None and b["level"] <= level and not b.get("is_break", False)
        )

    @staticmethod
    def _sum_durations_before_level(blinds: list, target_level: int) -> int:
        """Calculate total duration (in seconds) of all levels before target_level"""
        total_seconds = 0
        for blind in blinds:
            if blind["level"] < target_level:
                total_seconds += blind["duration"] * 60
        return total_seconds

    @staticmethod
    def _find_next_break(blinds: list, current_level: int, current_elapsed: int) -> dict:
        """Find the next break and calculate time until it"""
        # Calculate elapsed in all previous levels
        elapsed_in_previous = TournamentDayService._sum_durations_before_level(blinds, current_level)

        # Find current blind to get its duration
        current_blind = TournamentDayService._find_blind_by_level(blinds, current_level)
        if not current_blind:
            return None

        # Calculate time already elapsed in current level
        elapsed_in_current = current_elapsed - elapsed_in_previous
        remaining_in_current = (current_blind['duration'] * 60) - elapsed_in_current

        # Look for next break
        for blind in blinds:
            if blind['level'] > current_level and blind.get('is_break', False):
                # Calculate time from end of current level to this break
                time_between = 0
                for b in blinds:
                    if b['level'] > current_level and b['level'] < blind['level']:
                        time_between += b['duration'] * 60

                time_until_break = remaining_in_current + time_between

                return {
                    "level": blind['level'],
                    "duration": blind['duration'] * 60,
                    "time_until_break": max(0, time_until_break)
                }

        return None  # No break found

    @staticmethod
    def _calculate_current_level(blinds: list, elapsed_seconds: int) -> dict:
        """Calculate the correct level based on total elapsed time.
        Returns dict with level, time_remaining, elapsed_in_current_level."""
        if not blinds:
            return {"level": 1, "time_remaining": 0, "elapsed_in_current": 0}

        accumulated = 0
        for blind in blinds:
            level_duration = blind["duration"] * 60
            if elapsed_seconds < accumulated + level_duration:
                elapsed_in_current = elapsed_seconds - accumulated
                remaining = level_duration - elapsed_in_current
                return {
                    "level": blind["level"],
                    "time_remaining": max(0, remaining),
                    "elapsed_in_current": elapsed_in_current
                }
            accumulated += level_duration

        # Past all levels - stay on last level with 0 remaining
        last_blind = blinds[-1]
        return {
            "level": last_blind["level"],
            "time_remaining": 0,
            "elapsed_in_current": elapsed_seconds - (accumulated - last_blind["duration"] * 60)
        }

    @staticmethod
    def get_enriched_timer_status(day_id: str, day: Optional[TournamentDay] = None):
        """Get timer status with all calculated information (current/next blind, break info).
        Auto-advances level in DB when elapsed time exceeds current level duration.
        `day` may be passed pre-fetched (from the router validation) to skip a fetch;
        total_entries/chipcount come from a cached players scan, not from the day."""
        if day is None:
            day = TournamentDayService.get_tournament_day(day_id, include_entries=False)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        # Get all blinds sorted by level
        blinds = TournamentDayService._get_all_blinds(day_id, day.tournament_id)

        # Calculate current elapsed time if timer is running
        current_elapsed = day.elapsed_time or 0
        if day.timer_started_at and not day.is_paused:
            time_since_start = (datetime.now(timezone.utc) - day.timer_started_at).total_seconds()
            current_elapsed = (day.elapsed_time or 0) + round(time_since_start)

        # Calculate what level we SHOULD be at based on elapsed time
        level_calc = TournamentDayService._calculate_current_level(blinds, current_elapsed)
        correct_level = level_calc["level"]
        time_remaining_current = level_calc["time_remaining"]

        # Auto-advance: if DB level is behind the calculated level, update it
        db_level = day.current_level or 1
        if correct_level != db_level and not day.is_paused and blinds:
            supabase.table("tournament_days")\
                .update({"current_level": correct_level})\
                .eq("id", day_id)\
                .execute()

        # Find current blind (cópia: o número exibido é derivado, não vai pro banco)
        current_blind = TournamentDayService._find_blind_by_level(blinds, correct_level)
        if current_blind:
            current_blind = {
                **current_blind,
                "display_level": TournamentDayService._numero_exibido(blinds, current_blind.get("level")),
            }

        # Find next blind
        next_blind = TournamentDayService._proximo_blind(blinds, correct_level)
        if next_blind:
            next_blind = {
                **next_blind,
                "display_level": TournamentDayService._numero_exibido(blinds, next_blind.get("level")),
            }

        # Find next break and calculate time until it
        next_break_info = TournamentDayService._find_next_break(blinds, correct_level, current_elapsed)

        # Player aggregates (total_entries + chipcount) — cached for 60s in ONE scan,
        # since both only change on buy-in/rebuy/addon, not on the 3s poll. This avoids
        # the per-poll players scan that get_tournament_day used to do for total_entries.
        now = time.time()
        cached = _chipcount_cache.get(day_id)
        # Cache com formato antigo (menos posicoes) e tratado como vencido em vez
        # de lido pela metade: um campo faltando aqui viraria numero errado no
        # telao, e o custo e uma varredura a mais uma unica vez.
        if cached and len(cached) > 3 and (now - cached[0]) < _CHIPCOUNT_TTL:
            chipcount = cached[1]
            total_entries = cached[2]
            total_reentries = cached[3]
        else:
            try:
                agg_resp = supabase.table("tournament_players")\
                    .select(f"total_chips, {COLUNAS_DE_ENTRADA}")\
                    .eq("tournament_day_id", day_id)\
                    .execute()
                players_data = agg_resp.data or []
                if not players_data:
                    agg_resp2 = supabase.table("tournament_players")\
                        .select(f"total_chips, {COLUNAS_DE_ENTRADA}")\
                        .eq("tournament_id", day.tournament_id)\
                        .execute()
                    players_data = agg_resp2.data or []
                chipcount = sum(int(p.get("total_chips") or 0) for p in players_data)
                # ENTRADA = buy-in (e o classificado vindo de outro dia). Quem
                # recompra voltou ao torneio; nao entrou nele de novo.
                total_entries = _entradas_para_ativos(players_data, day)
                # REENTRADA = recompra. Add-on nao traz ninguem de volta.
                total_reentries = _reentradas(players_data)
                _chipcount_cache[day_id] = (now, chipcount, total_entries, total_reentries)
            except Exception:
                chipcount = cached[1] if cached else 0
                total_entries = cached[2] if cached else 0
                total_reentries = cached[3] if cached and len(cached) > 3 else 0

        # Jogadores ativos = ENTRADAS - ELIMINACOES. E a conta que a tela mostra
        # por extenso, e ela so fecha porque a recompra baixa o contador de
        # eliminacoes (ver TournamentPlayerService._desfazer_eliminacoes): quem
        # recompra voltou para a mesa, nao virou um jogador a mais.
        #
        # As eliminacoes sao lidas frescas da linha do dia, entao respondem na
        # hora mesmo com os agregados em cache.
        eliminations_count = day.eliminations_count if hasattr(day, 'eliminations_count') and day.eliminations_count else 0
        active_players = max(0, total_entries - eliminations_count)
        average_stack = round(chipcount / active_players) if active_players > 0 else 0

        # If is_paused=False but timer_started_at is None, the timer was never actually
        # started (inconsistent DB state). Treat it as paused to prevent the frontend
        # ticker from counting down while the server always returns the same value.
        effective_paused = (day.is_paused or False) or (not day.timer_started_at)

        # Instante ABSOLUTO (epoch, relógio do servidor) em que o nível atual termina
        # — e em que o próximo intervalo começa. Derivado de timer_started_at + duração
        # − elapsed_base + sum_before, SEM arredondamento e SEM depender de quando a
        # request é processada (o "agora" do servidor se cancela na conta). Assim
        # TODAS as telas calculam restante = fim − agora a partir do MESMO valor e
        # ficam em sincronia exata (some o offset de 1s entre Controle e Broadcast).
        current_level_ends_at = None
        next_break_starts_at = None
        if not effective_paused and day.timer_started_at and current_blind:
            tsa = day.timer_started_at.timestamp()
            elapsed_base = day.elapsed_time or 0
            level_dur = (current_blind.get("duration") or 0) * 60
            sum_before = TournamentDayService._sum_durations_before_level(blinds, correct_level)
            current_level_ends_at = tsa + level_dur - elapsed_base + sum_before
            if next_break_info:
                sum_before_break = TournamentDayService._sum_durations_before_level(
                    blinds, next_break_info["level"]
                )
                next_break_starts_at = tsa + sum_before_break - elapsed_base

        return {
            "current_level": correct_level,
            # Número para MOSTRAR (sem contar intervalos). `current_level` segue
            # sendo a posição interna, usada para sincronizar e avançar.
            "display_level": TournamentDayService._numero_exibido(blinds, correct_level),
            "elapsed_time": current_elapsed,
            "is_paused": effective_paused,
            "timer_started_at": day.timer_started_at.isoformat() if day.timer_started_at else None,
            "current_blind": current_blind,
            "next_blind": next_blind,
            "time_remaining_current_level": time_remaining_current,
            "next_break": next_break_info,
            "current_level_ends_at": current_level_ends_at,
            "next_break_starts_at": next_break_starts_at,
            "active_players": active_players,
            "total_entries": total_entries,
            # So recompras (add-on fica fora), para o telao exibir separado.
            "total_reentries": total_reentries,
            "eliminations_count": eliminations_count,
            "chipcount": chipcount,
            "average_stack": average_stack,
        }

    # ================================================
    # Simple Elimination Counter
    # ================================================

    @staticmethod
    def adjust_eliminations(day_id: str, count: int):
        """Contador de eliminacoes EM MASSA. Positivo elimina, negativo desfaz.

        So vale no modo 'bulk'. No modo mesa o contador e a contagem dos
        jogadores eliminados no assento: um "Eliminar 1" sem nome deixaria o
        numero descolado da lista, e a proxima reentrada nao teria a quem
        devolver.

        Teto nas ENTRADAS do dia: mais eliminados que entradas deixaria
        "jogadores ativos" negativo na TV. Cada reentrada ja baixou o contador
        quando foi vendida, entao um dia de 2 inscritos e 5 reentradas cabe
        exatamente 2 eliminacoes por vez.
        """
        day = TournamentDayService.get_tournament_day(day_id)
        if not day:
            raise ErroDeNegocio(
                "dia_nao_encontrado", "Tournament day not found", status=404
            )

        if modo_do_torneio(day.tournament_id, supabase) == MODO_MESA:
            raise ErroDeNegocio(
                "eliminacao_por_mesa",
                "Este torneio elimina jogadores pelas mesas: use o botão de "
                "eliminar no assento do jogador.",
                status=409,
            )

        total_entries = day.total_entries or 0
        # Atomico no banco (dois operadores clicando juntos nao perdem um clique).
        new_count = registrar_eliminacao(day_id, count, supabase)
        if new_count is None:
            new_count = day.eliminations_count or 0

        return {
            "eliminations_count": new_count,
            "active_players": max(0, total_entries - new_count),
            "total_entries": total_entries
        }
