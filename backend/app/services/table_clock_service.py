"""Relógio de mesa e time bank: o que precisa de servidor.

O relógio em si roda no tablet do dealer: o toque tem que responder na hora, e
a rede do salão não pode parar a contagem. Aqui fica a configuração do dia, a
lista da mesa e o uso dos cartões.

Tabelas (migração `database_migration_relogio_de_mesa.sql`):
- `table_clock_settings`  uma linha por dia;
- `time_bank_events`      cada cartão usado, devolvido ou ajustado.

As contas moram em `time_bank_regras`. `organization_id` vai explícito nas
linhas novas, copiado do torneio, como no livro de KOs.
"""
from typing import Dict, List, Optional

from app.database import supabase
from app.database.paginacao import todas_as_linhas
from app.models.table_clock import CartaoUsado, ConfiguracaoDoRelogio, PedidoDeAjuste
from app.services import time_bank_regras as regras
from app.services.eliminacao import MODO_MESA
from app.services.tournament_day_service import TournamentDayService
from app.utils.erros import ErroDeNegocio

# Na eliminação em massa o sistema não sabe quem saiu: a lista da mesa mostraria
# quem já foi embora, e o cartão sairia da pessoa errada.
MOTIVO_ELIMINACAO_EM_MASSA = "eliminacao_em_massa"
MOTIVO_BANCO_DESLIGADO = "desligado"
# Pendente entra: o dia só vira ativo quando o relógio de blinds liga, e o tablet
# é preparado antes disso. O limite segura os pendentes antigos que nunca rodaram.
LIMITE_DE_DIAS_NA_LISTA = 30


def _dia_nao_encontrado() -> ErroDeNegocio:
    return ErroDeNegocio("dia_nao_encontrado", "Tournament day not found", status=404)


def _eh_duplicado(erro: Exception) -> bool:
    texto = str(erro)
    return "23505" in texto or "duplicate key" in texto


class TableClockService:
    # ── Leituras de apoio ──

    @staticmethod
    def _dia_e_blinds(day_id: str):
        day, _, blinds = TournamentDayService.get_day_with_stage(day_id, with_blinds=True)
        if not day:
            raise _dia_nao_encontrado()
        # Dia sem estrutura própria usa a do torneio: sem isto, os intervalos não
        # contariam e o cartão do intervalo nunca chegaria.
        return day, TournamentDayService._get_all_blinds(day_id, day.tournament_id, blinds or [])

    @staticmethod
    def _torneio(tournament_id: str) -> dict:
        linhas = supabase.table("tournaments") \
            .select("id, name, organization_id, elimination_mode") \
            .eq("id", tournament_id).execute().data
        if not linhas:
            raise ErroDeNegocio("torneio_nao_encontrado", "Tournament not found", status=404)
        return linhas[0]

    @staticmethod
    def _mesa(table_id: str) -> dict:
        linhas = supabase.table("tournament_tables").select("*").eq("id", table_id).execute().data
        if not linhas:
            raise ErroDeNegocio("mesa_nao_encontrada", "Mesa não encontrada.", status=404)
        return linhas[0]

    @staticmethod
    def _inscricao(tp_id: str, day_id: str) -> dict:
        linhas = supabase.table("tournament_players") \
            .select("id, player_id, status, rebuy_count, tournament_day_id") \
            .eq("id", tp_id).execute().data
        if not linhas or linhas[0].get("tournament_day_id") != day_id:
            raise ErroDeNegocio("jogador_fora_do_dia", "Este jogador não está neste dia do torneio.")
        return linhas[0]

    @staticmethod
    def _eventos_do_dia(day_id: str) -> List[dict]:
        return todas_as_linhas(
            lambda: supabase.table("time_bank_events").select("*")
            .eq("tournament_day_id", day_id).order("created_at")
        )

    @staticmethod
    def _eventos_por_inscrito(eventos: List[dict]) -> Dict[str, List[dict]]:
        por_inscrito: Dict[str, List[dict]] = {}
        for evento in eventos:
            por_inscrito.setdefault(evento["tournament_player_id"], []).append(evento)
        return por_inscrito

    @staticmethod
    def _banco(config: ConfiguracaoDoRelogio, torneio: dict) -> dict:
        if torneio.get("elimination_mode") != MODO_MESA:
            return {"available": False, "reason": MOTIVO_ELIMINACAO_EM_MASSA}
        if not config.time_bank_enabled:
            return {"available": False, "reason": MOTIVO_BANCO_DESLIGADO}
        return {"available": True, "reason": None}

    @staticmethod
    def _saldo_de(inscricao: dict, day_id: str, config, blinds: list, nivel: int) -> int:
        eventos = supabase.table("time_bank_events").select("cards, entry_marker") \
            .eq("tournament_day_id", day_id) \
            .eq("tournament_player_id", inscricao["id"]).execute().data or []
        return regras.saldo(
            regras.direito(config, blinds, nivel), eventos, inscricao.get("rebuy_count") or 0,
        )

    # ── Configuração ──

    @staticmethod
    def obter_configuracao(day_id: str) -> ConfiguracaoDoRelogio:
        linhas = supabase.table("table_clock_settings").select("*") \
            .eq("tournament_day_id", day_id).execute().data
        return ConfiguracaoDoRelogio(**linhas[0]) if linhas else ConfiguracaoDoRelogio()

    @staticmethod
    def salvar_configuracao(day_id: str, data: ConfiguracaoDoRelogio) -> ConfiguracaoDoRelogio:
        day, _ = TableClockService._dia_e_blinds(day_id)
        torneio = TableClockService._torneio(day.tournament_id)
        supabase.table("table_clock_settings").upsert(
            {
                **data.model_dump(),
                "tournament_day_id": day_id,
                "organization_id": torneio["organization_id"],
            },
            on_conflict="tournament_day_id",
        ).execute()
        return TableClockService.obter_configuracao(day_id)

    # ── Tablet do dealer ──

    @staticmethod
    def dias_abertos(stage_id: Optional[str] = None) -> List[dict]:
        """Dias abertos para o tablet. Com a etapa selecionada no app (X-Stage-ID),
        só os torneios dela: o salão roda várias etapas e a lista misturava todas."""
        query = supabase.table("tournament_days") \
            .select("id, day_name, status, tournament_id, created_at, tournaments(name)") \
            .in_("status", ["active", "pending"])
        if stage_id:
            torneios = supabase.table("tournaments").select("id") \
                .eq("stage_id", stage_id).execute().data or []
            if not torneios:
                return []
            query = query.in_("tournament_id", [t["id"] for t in torneios])
        linhas = query.order("created_at", desc=True).limit(LIMITE_DE_DIAS_NA_LISTA).execute().data or []
        return [
            {
                "id": linha["id"],
                "day_name": linha.get("day_name"),
                "status": linha.get("status"),
                "created_at": linha.get("created_at"),
                "tournament_id": linha.get("tournament_id"),
                "tournament_name": (linha.get("tournaments") or {}).get("name"),
            }
            for linha in linhas
        ]

    @staticmethod
    def _assentos(table_id: str, day_id: str, config, blinds: list, nivel: int) -> List[dict]:
        """Quem está sentado e com quantos cartões. Eliminado sai da lista mesmo
        que o assento ainda não tenha sido liberado."""
        sentados = supabase.table("seat_allocations") \
            .select("seat_number, player_id, players(name, nickname)") \
            .eq("table_id", table_id).order("seat_number").execute().data or []
        if not sentados:
            return []
        inscritos = supabase.table("tournament_players") \
            .select("id, player_id, status, rebuy_count") \
            .eq("tournament_day_id", day_id) \
            .in_("player_id", [s["player_id"] for s in sentados]).execute().data or []
        por_jogador = {i["player_id"]: i for i in inscritos}
        eventos = TableClockService._eventos_por_inscrito(TableClockService._eventos_do_dia(day_id))
        cartoes = regras.direito(config, blinds, nivel)

        assentos = []
        for sentado in sentados:
            inscricao = por_jogador.get(sentado["player_id"])
            if not inscricao or inscricao.get("status") == "eliminated":
                continue
            jogador = sentado.get("players") or {}
            assentos.append({
                "seat_number": sentado["seat_number"],
                "tournament_player_id": inscricao["id"],
                "name": jogador.get("name"),
                "nickname": jogador.get("nickname"),
                "cards": regras.saldo(
                    cartoes, eventos.get(inscricao["id"], []), inscricao.get("rebuy_count") or 0,
                ),
            })
        return assentos

    @staticmethod
    def estado_da_mesa(table_id: str) -> dict:
        """Tudo o que o tablet precisa numa leitura só."""
        mesa = TableClockService._mesa(table_id)
        day_id = mesa["tournament_day_id"]
        day, blinds = TableClockService._dia_e_blinds(day_id)
        torneio = TableClockService._torneio(day.tournament_id)
        config = TableClockService.obter_configuracao(day_id)
        status = TournamentDayService.get_enriched_timer_status(day_id, day=day, blinds_do_dia=blinds)
        blind = status.get("current_blind") or {}
        banco = TableClockService._banco(config, torneio)
        return {
            "table": {
                "id": mesa["id"],
                "table_number": mesa.get("table_number"),
                "seats": mesa.get("seats"),
                "blocked_seats": mesa.get("blocked_seats") or [],
            },
            "day": {
                "id": day_id,
                "day_name": day.day_name,
                "tournament_id": day.tournament_id,
                "tournament_name": torneio.get("name"),
            },
            "settings": config.model_dump(),
            "clock_active": config.enabled and (status.get("display_level") or 1) >= config.start_level,
            "timer": {
                "level": status.get("current_level"),
                "display_level": status.get("display_level"),
                "is_break": bool(blind.get("is_break")),
                "is_paused": bool(status.get("is_paused")),
                # Pausado e ainda não começado travam igual, mas pedem coisas
                # diferentes ao floor: o tablet diz qual dos dois é.
                "started": bool(status.get("timer_started_at")),
                "small_blind": blind.get("small_blind"),
                "big_blind": blind.get("big_blind"),
                "ante": blind.get("ante"),
                "level_ends_at": status.get("current_level_ends_at"),
                "server_time": status.get("server_time"),
                # Pausado não há fim do nível: é o que o centro da mesa mostra.
                "time_remaining": status.get("time_remaining_current_level"),
            },
            "time_bank": banco,
            # A mesa desenhada mostra quem está sentado mesmo sem cartões. Na
            # eliminação em massa a lista estaria velha, então não sai.
            "seats": TableClockService._assentos(
                table_id, day_id, config, blinds, status.get("current_level") or 1,
            ) if banco["reason"] != MOTIVO_ELIMINACAO_EM_MASSA else [],
        }

    # ── Cartões ──

    @staticmethod
    def _evento_do_cliente(client_event_id: str) -> Optional[dict]:
        linhas = supabase.table("time_bank_events").select("*") \
            .eq("client_event_id", client_event_id).execute().data
        return linhas[0] if linhas else None

    @staticmethod
    def _contexto(day_id: str, tp_id: str):
        day, blinds = TableClockService._dia_e_blinds(day_id)
        inscricao = TableClockService._inscricao(tp_id, day_id)
        config = TableClockService.obter_configuracao(day_id)
        status = TournamentDayService.get_enriched_timer_status(day_id, day=day, blinds_do_dia=blinds)
        return day, blinds, inscricao, config, status.get("current_level") or 1

    @staticmethod
    def _resposta(evento: dict, inscricao: dict, day_id: str, config, blinds: list, nivel: int) -> dict:
        return {
            "event_id": evento["id"],
            "cards": TableClockService._saldo_de(inscricao, day_id, config, blinds, nivel),
        }

    @staticmethod
    def usar_cartao(table_id: str, data: CartaoUsado, user_id: Optional[str]) -> dict:
        mesa = TableClockService._mesa(table_id)
        day_id = mesa["tournament_day_id"]
        day, blinds, inscricao, config, nivel = TableClockService._contexto(day_id, data.tournament_player_id)

        ja_gravado = TableClockService._evento_do_cliente(data.client_event_id)
        if ja_gravado:
            return TableClockService._resposta(ja_gravado, inscricao, day_id, config, blinds, nivel)

        torneio = TableClockService._torneio(day.tournament_id)
        if not TableClockService._banco(config, torneio)["available"]:
            raise ErroDeNegocio("time_bank_indisponivel", "O time bank não está disponível neste dia.")
        if TableClockService._saldo_de(inscricao, day_id, config, blinds, nivel) <= 0:
            raise ErroDeNegocio("sem_cartoes", "Este jogador não tem cartões.", status=409)

        assento = supabase.table("seat_allocations").select("seat_number") \
            .eq("tournament_day_id", day_id).eq("player_id", inscricao["player_id"]).execute().data
        try:
            evento = supabase.table("time_bank_events").insert({
                "organization_id": torneio["organization_id"],
                "tournament_day_id": day_id,
                "tournament_player_id": inscricao["id"],
                "table_id": table_id,
                "seat_number": assento[0]["seat_number"] if assento else None,
                "kind": "use",
                "cards": -1,
                "entry_marker": inscricao.get("rebuy_count") or 0,
                "level": nivel,
                "client_event_id": data.client_event_id,
                "created_by": user_id,
            }).execute().data[0]
        except Exception as erro:
            # Dois envios do mesmo toque ao mesmo tempo: o índice único segura.
            evento = TableClockService._evento_do_cliente(data.client_event_id) if _eh_duplicado(erro) else None
            if not evento:
                raise
        return TableClockService._resposta(evento, inscricao, day_id, config, blinds, nivel)

    @staticmethod
    def desfazer_uso(event_id: str, user_id: Optional[str]) -> dict:
        linhas = supabase.table("time_bank_events").select("*").eq("id", event_id).execute().data
        if not linhas:
            raise ErroDeNegocio("evento_nao_encontrado", "Registro de cartão não encontrado.", status=404)
        original = linhas[0]
        if original.get("kind") != "use":
            raise ErroDeNegocio("evento_nao_desfazivel", "Só um cartão usado pode ser desfeito.")

        day_id = original["tournament_day_id"]
        _, blinds, inscricao, config, nivel = TableClockService._contexto(
            day_id, original["tournament_player_id"],
        )
        ja_desfeito = supabase.table("time_bank_events").select("*") \
            .eq("undoes_event_id", event_id).execute().data
        if ja_desfeito:
            return TableClockService._resposta(ja_desfeito[0], inscricao, day_id, config, blinds, nivel)

        desfeito = supabase.table("time_bank_events").insert({
            "organization_id": original.get("organization_id"),
            "tournament_day_id": day_id,
            "tournament_player_id": original["tournament_player_id"],
            "table_id": original.get("table_id"),
            "seat_number": original.get("seat_number"),
            "kind": "undo",
            "cards": 1,
            "entry_marker": original.get("entry_marker", 0),
            "level": nivel,
            "undoes_event_id": event_id,
            "created_by": user_id,
        }).execute().data[0]
        return TableClockService._resposta(desfeito, inscricao, day_id, config, blinds, nivel)

    @staticmethod
    def ajustar(day_id: str, tp_id: str, data: PedidoDeAjuste, user_id: Optional[str]) -> dict:
        day, blinds, inscricao, config, nivel = TableClockService._contexto(day_id, tp_id)
        torneio = TableClockService._torneio(day.tournament_id)
        evento = supabase.table("time_bank_events").insert({
            "organization_id": torneio["organization_id"],
            "tournament_day_id": day_id,
            "tournament_player_id": tp_id,
            "kind": "adjust",
            "cards": data.cards,
            "entry_marker": inscricao.get("rebuy_count") or 0,
            "level": nivel,
            "reason": data.reason,
            "created_by": user_id,
        }).execute().data[0]
        return TableClockService._resposta(evento, inscricao, day_id, config, blinds, nivel)

    # ── Floor ──

    @staticmethod
    def painel_do_dia(day_id: str) -> dict:
        day, blinds = TableClockService._dia_e_blinds(day_id)
        torneio = TableClockService._torneio(day.tournament_id)
        config = TableClockService.obter_configuracao(day_id)
        status = TournamentDayService.get_enriched_timer_status(day_id, day=day, blinds_do_dia=blinds)
        banco = TableClockService._banco(config, torneio)
        cartoes = regras.direito(config, blinds, status.get("current_level") or 1)
        painel = {
            "settings": config.model_dump(),
            "tournament_name": torneio.get("name"),
            "day_name": day.day_name,
            "time_bank": banco,
            "entitled": cartoes,
            "players": [],
        }
        if not banco["available"]:
            return painel

        inscritos = todas_as_linhas(
            lambda: supabase.table("tournament_players")
            .select("id, player_id, status, rebuy_count, players(name, nickname)")
            .eq("tournament_day_id", day_id).order("id")
        )
        assentos = todas_as_linhas(
            lambda: supabase.table("seat_allocations")
            .select("id, player_id, seat_number, tournament_tables(table_number)")
            .eq("tournament_day_id", day_id).order("id")
        )
        assento_de = {a["player_id"]: a for a in assentos}
        eventos = TableClockService._eventos_por_inscrito(TableClockService._eventos_do_dia(day_id))

        for inscricao in inscritos:
            if inscricao.get("status") == "eliminated":
                continue
            jogador = inscricao.get("players") or {}
            assento = assento_de.get(inscricao["player_id"]) or {}
            marca = inscricao.get("rebuy_count") or 0
            da_entrada = [
                e for e in eventos.get(inscricao["id"], []) if e.get("entry_marker", 0) == marca
            ]
            painel["players"].append({
                "tournament_player_id": inscricao["id"],
                "name": jogador.get("name"),
                "nickname": jogador.get("nickname"),
                "table_number": (assento.get("tournament_tables") or {}).get("table_number"),
                "seat_number": assento.get("seat_number"),
                "cards": regras.saldo(cartoes, da_entrada, marca),
                "used": sum(1 for e in da_entrada if e.get("kind") == "use")
                - sum(1 for e in da_entrada if e.get("kind") == "undo"),
            })
        painel["players"].sort(key=lambda p: (p["table_number"] is None, p["table_number"] or 0, p["seat_number"] or 0))
        return painel

    @staticmethod
    def historico(day_id: str) -> List[dict]:
        linhas = todas_as_linhas(
            lambda: supabase.table("time_bank_events")
            .select("id, kind, cards, seat_number, level, reason, created_at, "
                    "tournament_players(players(name)), tournament_tables(table_number)")
            .eq("tournament_day_id", day_id).order("created_at", desc=True)
        )
        return [
            {
                "id": linha["id"],
                "kind": linha.get("kind"),
                "cards": linha.get("cards"),
                "seat_number": linha.get("seat_number"),
                "level": linha.get("level"),
                "reason": linha.get("reason"),
                "created_at": linha.get("created_at"),
                "player_name": ((linha.get("tournament_players") or {}).get("players") or {}).get("name"),
                "table_number": (linha.get("tournament_tables") or {}).get("table_number"),
            }
            for linha in linhas
        ]
