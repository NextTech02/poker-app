import logging
import time
from typing import List, Optional
from datetime import datetime
from collections import defaultdict
from app.database import supabase
from app.models.tournament import (
    EliminationMode,
    KoFormat,
    TournamentCreate,
    TournamentUpdate,
    Tournament,
    TournamentSummary,
    TournamentDeleteImpact,
    TournamentCancelAndDeleteResult,
)
from app.utils.erros import ErroDeNegocio
from app.services.eliminacao import modo_do_torneio

logger = logging.getLogger("uvicorn.error")

# Mensagem da recusa de exclusão. O router a transforma em 409.
MSG_TORNEIO_COM_MOVIMENTO = (
    "Este torneio tem movimento financeiro e não pode ser excluído. "
    "Cancele as vendas no Caixa (o estorno devolve o dinheiro ao jogador e "
    "acerta o caixa da etapa) antes de excluir."
)

# Recusa do estorno em massa: sobra algo que o estorno automático não desfaz.
MSG_TORNEIO_NAO_ESTORNAVEL = (
    "Este torneio não pode ser excluído com as compras: há prêmio pago, venda "
    "com crédito ou ticket, satélite ou crédito de patrocinador ligado a ele. "
    "Resolva esses itens antes de excluir."
)

# Tempo de cada rodada do estorno em massa. Cada venda custa várias idas ao
# banco (contadores, caixa da etapa, gaveta, fidelidade); sem um teto, um
# torneio com dezenas de vendas estouraria o tempo da requisição no meio. A
# rodada para no teto e a tela chama de novo — o estorno retoma sozinho.
ORCAMENTO_DO_ESTORNO_EM_MASSA = 20.0

TIPOS_DE_ENTRADA = ("buy_in", "rebuy", "addon")


class MovimentoFinanceiroImpedeExclusao(Exception):
    """Recusa de exclusão: existe dinheiro em cima do que se quer apagar.

    Carrega o impacto medido para o router devolver os números junto do erro —
    o operador precisa ler QUANTO está em jogo, não só que "não deu".
    """

    def __init__(self, impacto, mensagem: str = MSG_TORNEIO_COM_MOVIMENTO):
        super().__init__(mensagem)
        self.impacto = impacto
        self.mensagem = mensagem


def resumir_vendas(vendas: List[dict]) -> dict:
    """Separa as vendas em dinheiro VIVO e histórico já estornado.

    `status` só existe depois da migração de cancelamento; sem a coluna a linha
    vem sem o campo e vale 'active' — o padrão do banco. Assim a medição
    funciona igual num schema antigo (o deploy não é atômico).

    'cancelling' conta como VIVA de propósito: é um estorno que começou e não
    terminou. Apagar a venda no meio do caminho congela o caixa torto para
    sempre, porque some justamente a linha que a retomada consulta.
    """
    resumo = {
        "entries": 0, "entries_amount": 0.0,
        "prizes": 0, "prizes_amount": 0.0,
        "cancelled_entries": 0,
    }
    for venda in vendas:
        if (venda.get("status") or "active") == "cancelled":
            resumo["cancelled_entries"] += 1
            continue
        valor = float(venda.get("amount") or 0)
        if venda.get("type") == "prize":
            resumo["prizes"] += 1
            resumo["prizes_amount"] = round(resumo["prizes_amount"] + valor, 2)
        else:
            resumo["entries"] += 1
            resumo["entries_amount"] = round(resumo["entries_amount"] + valor, 2)
    return resumo


def vendas_vivas(vendas: List[dict]) -> List[dict]:
    """Entradas que ainda valem dinheiro (inclui o estorno pela metade)."""
    return [
        v for v in vendas
        if v.get("type") in TIPOS_DE_ENTRADA and (v.get("status") or "active") != "cancelled"
    ]


def fila_do_estorno(vendas: List[dict]) -> List[dict]:
    """Ordem em que o estorno em massa desfaz as vendas.

    1. o estorno que parou no meio ('cancelling') — retomar antes de começar outro;
    2. reentradas e add-ons — o buy-in só pode ser estornado depois deles
       (`_exigir_recompras_canceladas`);
    3. os buy-ins.
    Dentro de cada grupo, da mais nova para a mais antiga.
    """
    fila = sorted(vendas_vivas(vendas), key=lambda v: v.get("created_at") or "", reverse=True)
    return sorted(fila, key=lambda v: (
        0 if v.get("status") == "cancelling" else 1,
        1 if v.get("type") == "buy_in" else 0,
    ))


def _normalizar_nome(nome: Optional[str]) -> str:
    return " ".join((nome or "").split()).casefold()


def contar_pagantes(inscricoes: List[dict]) -> int:
    """Inscrições que pagaram alguma coisa e não foram estornadas.

    Existe porque nem todo dinheiro deixa rastro em `transactions`: importação,
    ajuste manual e base antiga gravam o valor direto na inscrição. Sem contar
    isso, um torneio com jogador pago passaria pela guarda como se fosse vazio.
    """
    return sum(
        1 for i in inscricoes
        if (i.get("status") or "") != "cancelled" and float(i.get("total_spent") or 0) > 0
    )


# Bilhete de inscrição do torneio (troca do padrão do clube).
_CAMPOS_DO_BILHETE = ("ticket_logo_path", "ticket_city", "ticket_venue")


class TournamentService:
    @staticmethod
    def create_tournament(tournament_data: TournamentCreate, user_id: str) -> Tournament:
        """Create a new tournament - simplified to just name and stage"""
        data = {
            **tournament_data.model_dump(mode="json"),
            "created_by": user_id,
        }
        # 'bulk' é o padrão do BANCO: não mandá-lo deixa a criação funcionando
        # num banco que ainda não recebeu a coluna (o deploy não é atômico com
        # a migração). Só quem escolhe "por mesa" precisa dela.
        TournamentService._validar_ko(None, data)
        if data.get("elimination_mode") == EliminationMode.bulk.value:
            data.pop("elimination_mode")
        # Mesmo motivo: torneio sem KO não precisa das colunas novas.
        if data.get("ko_format") in (None, KoFormat.none.value):
            for campo in ("ko_format", "ko_percentage", "ko_cash_share"):
                data.pop(campo, None)
        # Garantido e nível só existem no Mystery (e só mandados quando há o
        # que gravar: banco sem a migração continua criando torneio).
        if data.get("ko_format") != KoFormat.mystery.value or not data.get("mystery_guarantee"):
            data.pop("mystery_guarantee", None)
        if data.get("ko_format") != KoFormat.mystery.value or not data.get("mystery_start_level"):
            data.pop("mystery_start_level", None)
        TournamentService._validar_equipes(None, data)
        # Torneio comum não manda as colunas de equipes (banco sem a migração).
        if not data.get("team_mode"):
            for campo in ("team_mode", "team_finalists", "team_tiebreak", "team_allow_reentry"):
                data.pop(campo, None)
        # Bilhete em branco = padrão do clube: não manda as colunas.
        for campo in _CAMPOS_DO_BILHETE:
            if not data.get(campo):
                data.pop(campo, None)

        response = supabase.table("tournaments").insert(data).execute()
        return Tournament(**response.data[0])

    @staticmethod
    def modo_de_eliminacao(tournament_id: Optional[str]) -> str:
        """'table' ou 'bulk' (padrão quando falta a coluna ou o valor)."""
        return modo_do_torneio(tournament_id, supabase)

    @staticmethod
    def get_tournaments(stage_id: Optional[str] = None) -> List[Tournament]:
        """Get all tournaments, optionally filtered by stage_id"""
        query = supabase.table("tournaments").select("*")

        if stage_id:
            query = query.eq("stage_id", stage_id)

        response = query.order("created_at", desc=True).execute()
        return [Tournament(**item) for item in response.data]

    @staticmethod
    def get_tournament(tournament_id: str) -> Optional[Tournament]:
        """Get a tournament by ID"""
        response = supabase.table("tournaments").select("*, sponsors(name)").eq("id", tournament_id).execute()

        if response.data:
            item = response.data[0]
            sponsor = item.pop("sponsors", None) or {}
            item["sponsor_name"] = sponsor.get("name")
            return Tournament(**item)
        return None

    @staticmethod
    def get_tournament_summary(tournament_id: Optional[str] = None, stage_id: Optional[str] = None) -> List[TournamentSummary]:
        """Tournament summaries — single round-trip via the `get_tournament_summary`
        Postgres RPC (GROUP BY aggregation in the DB). Falls back to the batched
        query path if the RPC isn't deployed yet or errors, so the endpoint keeps
        working before the migration is applied."""
        try:
            resp = supabase.rpc(
                "get_tournament_summary",
                {"p_stage_id": stage_id, "p_tournament_id": tournament_id},
            ).execute()
            linhas = resp.data or []
            if TournamentService._resumo_incompleto(linhas):
                logger.warning(
                    "RPC get_tournament_summary respondeu sem os agregados novos; "
                    "usando o caminho em Python. Aplique a migração "
                    "database_migration_summary_torneio_jogadores.sql."
                )
                return TournamentService._get_tournament_summary_batched(tournament_id, stage_id)
            return [TournamentSummary(**row) for row in linhas]
        except Exception as exc:  # RPC missing / transient error -> safe fallback
            logger.warning(
                "get_tournament_summary RPC unavailable, using batched fallback: %s", exc
            )
            return TournamentService._get_tournament_summary_batched(tournament_id, stage_id)

    # Agregados que a função SQL PRECISA devolver. Faltando qualquer um, o
    # Pydantic preencheria com o padrão do modelo — ZERO — e a tela mostraria
    # "0 jogadores" sem erro nenhum. Foi exatamente o que aconteceu: a contagem
    # foi corrigida aqui no Python e a função SQL ficou para trás, com o RPC
    # respondendo primeiro. Preferir o caminho lento a exibir zero é o certo:
    # número errado no card é pior que uma consulta a mais.
    _AGREGADOS_DO_RESUMO = ("total_entries", "total_players", "total_reentries", "total_days")

    @staticmethod
    def _resumo_incompleto(linhas: list) -> bool:
        """O RPC respondeu, mas de uma versão anterior da função?"""
        if not linhas:
            return False   # lista vazia é resposta legítima: nenhum torneio
        primeira = linhas[0] or {}
        return any(chave not in primeira for chave in TournamentService._AGREGADOS_DO_RESUMO)

    @staticmethod
    def _get_tournament_summary_batched(tournament_id: Optional[str] = None, stage_id: Optional[str] = None) -> List[TournamentSummary]:
        """Get tournament summaries with aggregated data from all tournament days.

        Performance: this used to be an O(1 + N + N*M) cascade of round-trips to
        the (remote) database — one query per tournament for its days, then one
        query per day for its players, plus one UPDATE per tournament. On a
        remote DB each round-trip costs tens of ms, so a handful of tournaments
        meant hundreds of queries and multi-second responses.

        It is now O(3) round-trips regardless of size: fetch tournaments, then
        all their days in a single IN query, then all players for those days in
        a single IN query. Aggregation is done in memory with hash maps (dicts)
        for O(1) grouping/lookup. Status sync writes are batched by target value
        (at most ~3 UPDATEs, only when something actually changed) instead of N.
        """
        query = supabase.table("tournaments").select("*, sponsors(name)")

        if tournament_id:
            query = query.eq("id", tournament_id)

        if stage_id:
            query = query.eq("stage_id", stage_id)

        tournaments = query.order("created_at", desc=True).execute().data or []
        if not tournaments:
            return []

        # --- 1 round-trip: all days for all these tournaments ---
        tournament_ids = [t["id"] for t in tournaments]
        days = (
            supabase.table("tournament_days")
            .select("id, tournament_id, day_type, status")
            .in_("tournament_id", tournament_ids)
            .execute()
            .data
            or []
        )

        # --- 1 round-trip: all players for the non-final days ---
        # Final days inherit data from qualifying days and must not be counted.
        counted_day_ids = [d["id"] for d in days if d.get("day_type") != "final"]
        players = []
        if counted_day_ids:
            players = (
                supabase.table("tournament_players")
                .select("tournament_day_id, buy_in_count, rebuy_count, addon_count, status")
                .in_("tournament_day_id", counted_day_ids)
                .execute()
                .data
                or []
            )

        # --- In-memory aggregation (hash maps, O(n)) ---
        # ENTRADAS, JOGADORES e REENTRADAS sao tres numeros distintos:
        #   entrada   = buy-in. Quem recompra voltou ao torneio, nao entrou de novo.
        #   jogador   = uma pessoa na mesa, por mais que recompre.
        #   reentrada = recompra, em campo proprio. Add-on compra fichas, nao
        #               traz ninguem de volta, e nao entra em contagem nenhuma.
        # Somar tudo num numero so era o que inflava a contagem do torneio.
        entries_by_day = defaultdict(int)
        players_by_day = defaultdict(int)
        reentries_by_day = defaultdict(int)
        for p in players:
            dia = p["tournament_day_id"]
            entries_by_day[dia] += p.get("buy_in_count") or 0
            # Inscricao estornada nao conta como gente na mesa.
            if (p.get("status") or "") != "cancelled":
                players_by_day[dia] += 1
            reentries_by_day[dia] += p.get("rebuy_count") or 0

        days_by_tournament = defaultdict(list)
        for d in days:
            days_by_tournament[d["tournament_id"]].append(d)

        status_updates = defaultdict(list)  # derived_status -> [tournament_id, ...]
        summaries = []
        for item in tournaments:
            tdays = days_by_tournament.get(item["id"], [])
            total_days = len(tdays)
            total_entries = 0
            total_players = 0
            total_reentries = 0
            day_statuses = []
            for day in tdays:
                day_statuses.append(day.get("status", "pending"))
                if day.get("day_type") == "final":
                    continue
                total_entries += entries_by_day.get(day["id"], 0)
                total_players += players_by_day.get(day["id"], 0)
                total_reentries += reentries_by_day.get(day["id"], 0)

            # Derive tournament status from its days
            if day_statuses:
                if "active" in day_statuses:
                    derived_status = "active"
                elif all(s in ("completed", "cancelled") for s in day_statuses) and "completed" in day_statuses:
                    derived_status = "completed"
                else:
                    derived_status = "pending"

                if item.get("status") != derived_status:
                    status_updates[derived_status].append(item["id"])
                    item["status"] = derived_status

            item["total_entries"] = total_entries
            item["total_players"] = total_players
            item["total_reentries"] = total_reentries
            item["total_days"] = total_days
            sponsor = item.pop("sponsors", None) or {}
            item["sponsor_name"] = sponsor.get("name")
            summaries.append(TournamentSummary(**item))

        # --- Batched status sync: one UPDATE per distinct status (only if changed) ---
        for status_value, ids in status_updates.items():
            supabase.table("tournaments").update({"status": status_value}).in_("id", ids).execute()

        return summaries

    @staticmethod
    def update_tournament(tournament_id: str, tournament_data: TournamentUpdate) -> Optional[Tournament]:
        """Update a tournament (name and/or stage_id)"""
        data = tournament_data.model_dump(exclude_unset=True, mode="json")
        if data.get("elimination_mode") is None:
            data.pop("elimination_mode", None)
        elif data["elimination_mode"] == EliminationMode.table.value:
            TournamentService._recusar_mesa_com_eliminacoes(tournament_id)
        for campo in ("ko_format", "ko_percentage", "ko_cash_share", "mystery_guarantee",
                      "team_mode", "team_tiebreak", "team_allow_reentry"):
            if campo in data and data[campo] is None:
                data.pop(campo)
        TournamentService._validar_ko(tournament_id, data)
        TournamentService._preparar_bilhete(tournament_id, data)
        if any(c.startswith("team_") for c in data) or "has_qualifying" in data or "elimination_mode" in data:
            TournamentService._validar_equipes(tournament_id, data)

        response = (
            supabase.table("tournaments")
            .update(data)
            .eq("id", tournament_id)
            .execute()
        )

        if response.data:
            return Tournament(**response.data[0])
        return None

    @staticmethod
    def _validar_ko(tournament_id: Optional[str], data: dict) -> None:
        """Regras da premiação por eliminação (criação e edição).

        - KO exige eliminação POR MESA: o modo em massa não sabe quem saiu,
          muito menos quem eliminou. Isso também trava a volta para em massa.
        - v1: só torneio SEM dias classificatórios (o bounty não atravessa
          para o Dia Final ainda).
        - Formato e percentuais não mudam depois da primeira venda: cada
          venda congelou a sua parte KO, e mudar a regra no meio deixaria o
          pozo metade de um jeito, metade de outro.
        - KO fixo paga sempre 100% em dinheiro.
        """
        mexe_em_ko = any(c in data for c in ("ko_format", "ko_percentage", "ko_cash_share"))
        atual = {}
        if tournament_id:
            linhas = (
                supabase.table("tournaments").select("*")
                .eq("id", tournament_id).execute().data or []
            )
            atual = linhas[0] if linhas else {}
        final = {**atual, **data}
        # Garantido e nível do Mystery: livres até a fase começar; depois, os
        # envelopes já foram montados sobre eles.
        if atual.get("mystery_started_at"):
            for campo in ("mystery_guarantee", "mystery_start_level"):
                if campo in data and (data[campo] or 0) != (atual.get(campo) or 0):
                    raise ErroDeNegocio(
                        "mystery_config_bloqueada",
                        "A fase Mystery já começou: o garantido e o nível de início não mudam mais.",
                        status=409,
                    )
        formato = final.get("ko_format") or KoFormat.none.value
        if formato == KoFormat.ko.value and (mexe_em_ko or "ko_cash_share" in final):
            data["ko_cash_share"] = 100
            final["ko_cash_share"] = 100

        if formato != KoFormat.none.value:
            if (final.get("elimination_mode") or EliminationMode.bulk.value) != EliminationMode.table.value:
                raise ErroDeNegocio(
                    "ko_exige_modo_mesa",
                    "Premiação por eliminação exige eliminar pelas mesas: o modo em massa não registra quem eliminou.",
                )
            if final.get("has_qualifying"):
                raise ErroDeNegocio(
                    "ko_sem_classificatorio",
                    "Por enquanto, a premiação por eliminação funciona só em torneio sem dias classificatórios.",
                )
            if float(final.get("ko_percentage") or 0) <= 0:
                raise ErroDeNegocio(
                    "ko_percentual_obrigatorio",
                    "Informe a porcentagem do pozo que vai para os prêmios por eliminação.",
                )

        if not tournament_id or not mexe_em_ko:
            return
        mudou = (
            (atual.get("ko_format") or KoFormat.none.value) != formato
            or float(atual.get("ko_percentage") or 0) != float(final.get("ko_percentage") or 0)
            or (formato == KoFormat.pko.value
                and float(atual.get("ko_cash_share") or 0) != float(final.get("ko_cash_share") or 0))
        )
        if not mudou:
            return
        vendas = (
            supabase.table("transactions").select("id, status, type")
            .eq("tournament_id", tournament_id)
            .in_("type", ["buy_in", "rebuy", "addon"]).execute().data or []
        )
        if any((v.get("status") or "active") == "active" for v in vendas):
            raise ErroDeNegocio(
                "ko_config_bloqueada_com_vendas",
                "O torneio já tem vendas: o formato e as porcentagens do KO não podem mais mudar.",
                status=409,
            )

    @staticmethod
    def _preparar_bilhete(tournament_id: str, data: dict) -> None:
        """Bilhete do torneio (imagem, cidade, sede). Texto em branco vira nulo
        (= padrão do clube). Banco sem a migração do bilhete: sem nada a
        gravar, os campos saem do update e a edição continua funcionando."""
        campos = [c for c in _CAMPOS_DO_BILHETE if c in data]
        if not campos:
            return
        for campo in campos:
            valor = data[campo]
            data[campo] = valor.strip() if isinstance(valor, str) and valor.strip() else None
        linhas = supabase.table("tournaments").select("*").eq("id", tournament_id).execute().data or []
        if linhas and "ticket_city" not in linhas[0]:
            if any(data[c] for c in campos):
                raise ErroDeNegocio(
                    "bilhete_indisponivel",
                    "O bilhete personalizado ainda não está disponível neste servidor.",
                    status=409,
                )
            for campo in campos:
                data.pop(campo)

    @staticmethod
    def _validar_equipes(tournament_id: Optional[str], data: dict) -> None:
        """Torneio por equipes (criação e edição).

        - Fase 1 = dia classificatório e Fase 2 = dia final: exige
          classificatório e eliminação POR MESA (os pontos saem da posição na
          mesa — o modo em massa não sabe quem caiu em qual mesa).
        - Não combina com KO (o KO não atravessa para o dia final).
        - Ligar/desligar só enquanto ninguém se inscreveu: as equipes, o
          sorteio e os pontos dependem disso desde a primeira venda.
        """
        atual = {}
        if tournament_id:
            linhas = supabase.table("tournaments").select("*").eq("id", tournament_id).execute().data or []
            atual = linhas[0] if linhas else {}
        if atual and "team_mode" not in atual and not data.get("team_mode"):
            # Banco sem a migração de equipes: um torneio comum não manda as
            # colunas novas (a edição continua funcionando).
            for campo in ("team_mode", "team_finalists", "team_tiebreak", "team_allow_reentry"):
                data.pop(campo, None)
        final = {**atual, **data}
        if final.get("team_mode"):
            if not final.get("has_qualifying"):
                raise ErroDeNegocio(
                    "equipes_exige_classificatorio",
                    "Torneio por equipes precisa do dia da Fase 1 (classificatório) e do dia final.",
                )
            if (final.get("elimination_mode") or EliminationMode.bulk.value) != EliminationMode.table.value:
                raise ErroDeNegocio(
                    "equipes_exige_modo_mesa",
                    "Torneio por equipes exige eliminar pelas mesas: os pontos saem da posição em cada mesa.",
                )
            if (final.get("ko_format") or KoFormat.none.value) != KoFormat.none.value:
                raise ErroDeNegocio(
                    "equipes_sem_ko", "Torneio por equipes não combina com premiação por eliminação (KO).",
                )
        if not tournament_id or "team_mode" not in data:
            return
        if bool(data.get("team_mode")) == bool(atual.get("team_mode")):
            return
        inscritos = (
            supabase.table("tournament_players").select("id, status")
            .eq("tournament_id", tournament_id).execute().data or []
        )
        if any((i.get("status") or "") != "cancelled" for i in inscritos):
            raise ErroDeNegocio(
                "modo_equipes_bloqueado_com_inscritos",
                "O torneio já tem inscritos: o modo por equipes não pode mais ser ligado ou desligado.",
                status=409,
            )

    @staticmethod
    def _recusar_mesa_com_eliminacoes(tournament_id: str) -> None:
        """Passar para "por mesa" com eliminações já lançadas no contador?

        No modo mesa o contador É a contagem de jogadores eliminados. As
        eliminações em massa não dizem QUEM saiu — virar a chave agora faria a
        primeira recontagem apagar todas elas e os ATIVOS subirem na TV no meio
        do evento. O caminho contrário (mesa → em massa) é seguro: o contador
        já está certo e só passa a ser mexido pelos botões.
        """
        if TournamentService.modo_de_eliminacao(tournament_id) == EliminationMode.table.value:
            return
        dias = (
            supabase.table("tournament_days")
            .select("id, eliminations_count")
            .eq("tournament_id", tournament_id)
            .execute()
            .data
            or []
        )
        if any(int(d.get("eliminations_count") or 0) > 0 for d in dias):
            raise ErroDeNegocio(
                "modo_de_eliminacao_bloqueado",
                "Este torneio já tem eliminações lançadas em massa. Para eliminar "
                "pelas mesas, zere o contador no Controle antes de trocar o modo.",
                status=409,
            )

    @staticmethod
    def get_delete_impact(tournament_id: str) -> Optional[TournamentDeleteImpact]:
        """Mede o estrago da exclusão ANTES de executá-la.

        Três round-trips fixos (dias, inscrições, vendas), independentemente do
        tamanho do torneio: é uma tela de confirmação, não um poll.

        `select("*")` nas vendas de propósito: pedir a coluna `status` pelo nome
        estoura no PostgREST se a migração de cancelamento ainda não rodou
        naquele ambiente, e a guarda ficaria pior do que não existir — a
        exclusão voltaria a passar.
        """
        torneio = (
            supabase.table("tournaments").select("id, name")
            .eq("id", tournament_id).execute()
        )
        if not torneio.data:
            return None

        dias = (
            supabase.table("tournament_days").select("id")
            .eq("tournament_id", tournament_id).execute().data or []
        )
        inscricoes = (
            supabase.table("tournament_players").select("id, status, total_spent")
            .eq("tournament_id", tournament_id).execute().data or []
        )
        vendas = (
            supabase.table("transactions").select("*")
            .eq("tournament_id", tournament_id).execute().data or []
        )

        resumo = resumir_vendas(vendas)
        pagantes = contar_pagantes(inscricoes)
        vivas = vendas_vivas(vendas)
        nao_dinheiro = sum(1 for v in vivas if (v.get("payment_source") or "cash") != "cash")
        # Quem pagou sem venda viva (importação, ajuste manual): o estorno das
        # vendas não zera esse dinheiro.
        com_venda = {v.get("tournament_player_id") for v in vivas}
        sem_venda = sum(
            1 for i in inscricoes
            if (i.get("status") or "") != "cancelled"
            and float(i.get("total_spent") or 0) > 0
            and i.get("id") not in com_venda
        )
        ligacoes = TournamentService._ligacoes_que_travam(
            tournament_id, [d["id"] for d in dias], [i["id"] for i in inscricoes]
        )
        bloqueado = bool(resumo["entries"] or resumo["prizes"] or pagantes or ligacoes)
        return TournamentDeleteImpact(
            tournament_id=tournament_id,
            tournament_name=torneio.data[0].get("name") or "",
            days=len(dias),
            players=len(inscricoes),
            paying_players=pagantes,
            blocked=bloqueado,
            non_cash_entries=nao_dinheiro,
            blocking_links=ligacoes,
            paying_without_sale=sem_venda,
            # Só vendas em dinheiro em cima: o estorno em massa resolve tudo.
            can_cancel_and_delete=bool(
                bloqueado and resumo["entries"] and not resumo["prizes"]
                and not nao_dinheiro and not sem_venda and not ligacoes
            ),
            **resumo,
        )

    @staticmethod
    def _ligacoes_que_travam(tournament_id: str, dias: List[str], inscricoes: List[str]) -> List[str]:
        """Registros de OUTRAS tabelas que o banco não deixa apagar junto.

        As FKs de `satellite_tickets`, `credit_transactions` e da vaga de
        satélite em `prize_allocations` não são CASCADE: com qualquer uma
        delas apontando para o torneio (ou um dia, ou uma inscrição dele), o
        DELETE estoura no banco. Tabela ausente num ambiente antigo = sem
        ligação.
        """
        def existe(montar) -> bool:
            try:
                return bool(montar().limit(1).execute().data)
            except Exception:
                logger.warning("conferência de ligação do torneio falhou", exc_info=True)
                return False

        ligacoes: List[str] = []
        tickets = existe(lambda: supabase.table("satellite_tickets").select("id")
                         .eq("target_tournament_id", tournament_id))
        if not tickets and dias:
            tickets = existe(lambda: supabase.table("satellite_tickets").select("id")
                             .in_("target_tournament_day_id", dias))
        if not tickets and inscricoes:
            tickets = existe(lambda: supabase.table("satellite_tickets").select("id")
                             .in_("redeemed_tournament_player_id", inscricoes))
        if tickets:
            ligacoes.append("satellite_tickets")
        if existe(lambda: supabase.table("prize_allocations").select("id")
                  .eq("vaga_target_tournament_id", tournament_id)):
            ligacoes.append("satellite_prizes")
        credito = existe(lambda: supabase.table("credit_transactions").select("id")
                         .eq("tournament_id", tournament_id))
        if not credito and dias:
            credito = existe(lambda: supabase.table("credit_transactions").select("id")
                             .in_("tournament_day_id", dias))
        if credito:
            ligacoes.append("sponsor_credit")
        return ligacoes

    @staticmethod
    def delete_tournament(tournament_id: str) -> bool:
        """Apaga o torneio — RECUSANDO quando ainda há dinheiro em cima.

        A recusa mora AQUI, no service, e não na tela: as FKs para `tournaments`
        são ON DELETE CASCADE, então um DELETE direto na API (curl, script,
        integração) apagaria em cascata a venda, o dinheiro recebido e o
        registro de quem pagou. E o caixa da etapa NÃO é estornado por isso —
        os gatilhos de caixa são só de INSERT —, então o saldo continuaria
        apontando dinheiro cuja origem sumiu e a etapa nunca mais fecharia.

        O caminho para apagar um torneio criado por engano continua existindo:
        cancelar as vendas no Caixa (o estorno devolve o dinheiro e acerta o
        caixa) e só então excluir. Premiação PAGA nunca libera — evento com
        prêmio pago é história fechada, não rascunho.
        """
        impacto = TournamentService.get_delete_impact(tournament_id)
        if impacto is None:
            return False
        if impacto.blocked:
            raise MovimentoFinanceiroImpedeExclusao(impacto)

        response = supabase.table("tournaments").delete().eq("id", tournament_id).execute()
        return len(response.data) > 0

    @staticmethod
    def cancel_sales_and_delete(
        tournament_id: str,
        user_id: str,
        reason: str,
        confirm_name: str,
        orcamento_segundos: float = ORCAMENTO_DO_ESTORNO_EM_MASSA,
    ) -> Optional[TournamentCancelAndDeleteResult]:
        """Torneio criado por engano: estorna TODAS as vendas e exclui.

        Não existe atalho de dinheiro aqui: cada venda passa pelo MESMO estorno
        do Caixa (`TransactionService.cancel_transaction`) — devolve a gaveta do
        operador, o caixa da etapa, os contadores e a fidelidade, e avisa o que
        não conseguiu acertar sozinho (sangria já feita, caixa já fechado). Só
        quando não sobra venda viva o torneio é apagado, pela exclusão de
        sempre, que reconfere a guarda.

        Roda em RODADAS de `orcamento_segundos`: devolve `remaining` > 0 e a
        tela chama de novo. Interromper no meio é seguro — cada estorno é
        retomável e nunca debita duas vezes.

        Recusa (sem estornar nada) quando sobra o que o estorno não desfaz:
        prêmio pago, venda com crédito/ticket, satélite, crédito de patrocinador
        ou inscrito pago sem venda.
        """
        from app.services.transaction_service import TransactionService

        impacto = TournamentService.get_delete_impact(tournament_id)
        if impacto is None:
            return None
        if _normalizar_nome(confirm_name) != _normalizar_nome(impacto.tournament_name):
            raise ErroDeNegocio(
                "nome_do_torneio_nao_confere",
                "O nome digitado não é o deste torneio.",
                nome=impacto.tournament_name,
            )
        if impacto.blocked and not impacto.can_cancel_and_delete:
            raise MovimentoFinanceiroImpedeExclusao(impacto, MSG_TORNEIO_NAO_ESTORNAVEL)

        vendas = (
            supabase.table("transactions").select("*")
            .eq("tournament_id", tournament_id).execute().data or []
        )
        fila = fila_do_estorno(vendas)
        inicio = time.monotonic()
        estornadas = 0
        devolvido = 0.0
        avisos: List[str] = []
        for venda in fila:
            # Pelo menos UMA venda por rodada: a rodada sempre avança.
            if estornadas and time.monotonic() - inicio >= orcamento_segundos:
                break
            try:
                detalhe = TransactionService.cancel_transaction(venda["id"], user_id, reason)
            except ErroDeNegocio as erro:
                # KO já entregue, estorno disputado por outra tela... O que já
                # foi estornado fica estornado (dinheiro devolvido de verdade);
                # a tela recarrega o impacto e mostra o que sobrou.
                raise ErroDeNegocio(
                    "estorno_em_massa_interrompido",
                    f"O estorno parou numa venda: {erro.message}",
                    status=409,
                    estornadas=estornadas,
                    motivo=erro.message,
                    motivo_code=erro.code,
                ) from erro
            except Exception as erro:
                logger.exception("estorno em massa: venda %s parou no meio", venda.get("id"))
                raise ErroDeNegocio(
                    "estorno_em_massa_interrompido",
                    "Um estorno parou no meio. Tente de novo: ele retoma de onde parou.",
                    status=409,
                    estornadas=estornadas,
                ) from erro
            estornadas += 1
            devolvido += float(venda.get("amount") or 0)
            avisos.extend(detalhe.cancel_warnings or [])

        # Mesmo aviso repetido em várias vendas (ex.: "a etapa já teve
        # sangria") aparece uma vez só.
        avisos = list(dict.fromkeys(avisos))
        restantes = len(fila) - estornadas
        if restantes:
            return TournamentCancelAndDeleteResult(
                deleted=False, cancelled=estornadas, remaining=restantes,
                refunded_amount=round(devolvido, 2), warnings=avisos,
            )

        excluido = TournamentService.delete_tournament(tournament_id)
        return TournamentCancelAndDeleteResult(
            deleted=excluido, cancelled=estornadas, remaining=0,
            refunded_amount=round(devolvido, 2), warnings=avisos,
        )
