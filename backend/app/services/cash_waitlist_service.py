"""Fila de espera do cash game.

A FILA É O QUE FAZ A SALA GIRAR. Numa noite cheia há mais gente do que cadeira,
e quem decide a ordem é um papel na mão de alguém — que se perde, some, e vira
discussão na frente da mesa. O sistema existe para essa ordem ser a mesma para
todo mundo que olhar a tela.

DUAS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:

1. **A posição NUNCA é reciclada.** Quando alguém senta ou desiste, os que
   estão atrás NÃO sobem de número. A posição é o registro de quem chegou
   quando; renumerar apagaria a única prova de que a ordem foi respeitada — e é
   justamente isso que o jogador contesta no balcão.

2. **Chamar e RESERVAR são passos separados**, porque na sala eles são: o
   operador grita o nome antes de saber em qual mesa vai abrir o lugar. Quando
   a cadeira é definida, ela é reservada — entre o "é a sua vez" e o jogador
   chegar do bar passam minutos, e nesse intervalo outro operador sentaria
   alguém ali. A reserva tem PRAZO: sem ele, uma chamada esquecida travaria a
   cadeira a noite inteira.

3. **Reservar não é sentar.** Sentar é vender fichas, e isso passa pelo caixa.
   Misturar as duas coisas criaria jogador sentado sem ter pago.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    CashWaitlistCreate,
    CashWaitlistResponse,
    CashWaitlistSeat,
    CashWaitlistUpdate,
)
from app.services.cash_day_service import CashDayService
from app.services.cash_table_service import CashTableService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

ESPERANDO = ("waiting", "called")


def _agora() -> datetime:
    return datetime.now(timezone.utc)


class CashWaitlistService:

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def get_entry(entry_id: str) -> dict:
        resp = supabase.table("cash_waitlist").select("*").eq("id", entry_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "fila_registro_nao_encontrado", "Registro da fila não encontrado.", status=404
            )
        return resp.data[0]

    @staticmethod
    def list_entries(
        cash_day_id: Optional[str] = None,
        status: Optional[str] = None,
        game_type_id: Optional[str] = None,
    ) -> List[CashWaitlistResponse]:
        query = supabase.table("cash_waitlist").select("*")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        if status:
            query = query.eq("status", status)
        if game_type_id:
            query = query.eq("game_type_id", game_type_id)
        linhas = query.order("position").execute().data or []
        return CashWaitlistService._enriquecer(linhas)

    @staticmethod
    def _enriquecer(linhas: List[dict]) -> List[CashWaitlistResponse]:
        if not linhas:
            return []
        jogadores = [l["player_id"] for l in linhas if l.get("player_id")]
        nomes = {}
        if jogadores:
            rows = supabase.table("players").select("id, name, nickname") \
                .in_("id", list(set(jogadores))).execute().data or []
            nomes = {r["id"]: (r.get("nickname") or r.get("name")) for r in rows}

        tipos = [l["game_type_id"] for l in linhas if l.get("game_type_id")]
        modalidades = {}
        if tipos:
            rows = supabase.table("cash_game_types").select("id, name") \
                .in_("id", list(set(tipos))).execute().data or []
            modalidades = {r["id"]: r.get("name") for r in rows}

        mesas_ids = [l["table_id"] for l in linhas if l.get("table_id")]
        mesas = {}
        if mesas_ids:
            rows = supabase.table("cash_tables").select("id, table_number") \
                .in_("id", list(set(mesas_ids))).execute().data or []
            mesas = {r["id"]: r.get("table_number") for r in rows}

        return [
            CashWaitlistResponse(
                **l,
                # O visitante ainda sem cadastro aparece pelo nome anotado.
                player_name=nomes.get(l.get("player_id")) or l.get("guest_name"),
                game_type_name=modalidades.get(l.get("game_type_id")),
                table_number=mesas.get(l.get("table_id")),
            )
            for l in linhas
        ]

    # ============================================================
    # Entrar na fila
    # ============================================================

    @staticmethod
    def add(
        cash_day_id: str,
        data: CashWaitlistCreate,
        organization_id: Optional[str] = None,
    ) -> CashWaitlistResponse:
        CashDayService.require_open_day(cash_day_id)

        if not data.player_id and not (data.guest_name or "").strip():
            raise ErroDeNegocio(
                "fila_sem_identificacao",
                "Informe o jogador ou um nome para a fila.",
            )

        if data.player_id:
            ja_na_fila = supabase.table("cash_waitlist").select("id, position") \
                .eq("cash_day_id", cash_day_id).eq("player_id", data.player_id) \
                .in_("status", list(ESPERANDO)).limit(1).execute()
            if ja_na_fila.data:
                # Quem pergunta "já me anotou?" e é anotado de novo passaria na
                # frente de quem chegou antes.
                raise ErroDeNegocio(
                    "jogador_ja_na_fila",
                    "Este jogador já está na fila de hoje.",
                    status=409,
                    player_id=data.player_id,
                    position=ja_na_fila.data[0].get("position"),
                )
            sentado = supabase.table("cash_player_sessions").select("id") \
                .eq("cash_day_id", cash_day_id).eq("player_id", data.player_id) \
                .eq("status", "active").limit(1).execute()
            if sentado.data:
                raise ErroDeNegocio(
                    "jogador_ja_sentado",
                    "Este jogador já está sentado numa mesa.",
                    status=409, player_id=data.player_id,
                )

        payload = {
            "cash_day_id": cash_day_id,
            "game_type_id": data.game_type_id,
            "table_id": data.table_id,
            "player_id": data.player_id,
            "guest_name": (data.guest_name or "").strip() or None,
            "position": CashWaitlistService._proxima_posicao(cash_day_id),
            "status": "waiting",
            "notes": data.notes,
        }
        if organization_id:
            payload["organization_id"] = organization_id

        resp = supabase.table("cash_waitlist").insert(payload).execute()
        return CashWaitlistService._enriquecer(resp.data)[0]

    @staticmethod
    def _proxima_posicao(cash_day_id: str) -> int:
        """Sempre a MAIOR posição já usada + 1, incluindo quem já saiu da fila.

        Reaproveitar o número de quem sentou faria duas pessoas da mesma noite
        terem a posição 7 — e a ordem deixaria de ser prova de nada.
        """
        ultima = supabase.table("cash_waitlist").select("position") \
            .eq("cash_day_id", cash_day_id) \
            .order("position", desc=True).limit(1).execute()
        return int((ultima.data[0]["position"] if ultima.data else 0)) + 1

    # ============================================================
    # Chamar, sentar, desistir
    # ============================================================

    @staticmethod
    def call(entry_id: str) -> CashWaitlistResponse:
        """Anuncia a vez. A cadeira ainda não é reservada.

        Chamar e reservar são passos separados porque na sala eles são: o
        operador grita o nome antes de saber em qual mesa vai abrir o lugar.
        Quem já sabe a cadeira usa `seat`, que reserva.
        """
        entrada = CashWaitlistService._esperando(entry_id)
        atualizacao = {"status": "called", "called_at": _agora().isoformat()}
        resp = supabase.table("cash_waitlist").update(atualizacao) \
            .eq("id", entry_id).execute()
        return CashWaitlistService._enriquecer(resp.data or [entrada])[0]

    @staticmethod
    def seat(entry_id: str, data: CashWaitlistSeat) -> CashWaitlistResponse:
        """Reserva a cadeira para quem foi chamado.

        NÃO senta o jogador: sentar é vender fichas, e isso passa pelo caixa
        (`/tables/{id}/seats/{n}/sit`). Aqui a fila só garante o lugar até ele
        chegar ao balcão. Misturar as duas coisas criaria jogador sentado sem
        ter pago.
        """
        entrada = CashWaitlistService._esperando(entry_id)
        if not entrada.get("player_id"):
            # A reserva prende a cadeira para uma PESSOA identificada; um nome
            # anotado não dá para conferir quando outro jogador senta ali.
            raise ErroDeNegocio(
                "fila_sem_cadastro",
                "Cadastre o jogador antes de reservar o lugar.",
                entry_id=entry_id,
            )

        mesa = CashTableService.get_table(data.table_id)
        if mesa.get("status") == "closed":
            raise ErroDeNegocio("mesa_ja_fechada", "Esta mesa já foi fechada.", status=409)

        assento = supabase.table("cash_seats").select("*") \
            .eq("table_id", data.table_id).eq("seat_number", data.seat_number) \
            .limit(1).execute()
        if not assento.data:
            raise ErroDeNegocio(
                "assento_invalido", "Este lugar não existe nesta mesa.",
                status=404, seat_number=data.seat_number,
            )

        # Compare-and-set: quem perde a corrida recebe a recusa nomeada em vez
        # de uma segunda reserva em cima da primeira.
        tomada = supabase.table("cash_seats").update({
            "status": "reserved",
            "reserved_for": entrada["player_id"],
            "reserved_until": (_agora() + timedelta(minutes=data.minutes)).isoformat(),
            "updated_at": _agora().isoformat(),
        }).eq("id", assento.data[0]["id"]).eq("status", "free").execute()
        if not tomada.data:
            raise ErroDeNegocio(
                "assento_ocupado", "Este lugar já está ocupado.",
                status=409, seat_number=data.seat_number,
            )

        resp = supabase.table("cash_waitlist").update({
            "status": "called",
            "called_at": entrada.get("called_at") or _agora().isoformat(),
            "table_id": data.table_id,
            "seat_id": assento.data[0]["id"],
        }).eq("id", entry_id).execute()
        return CashWaitlistService._enriquecer(resp.data or [entrada])[0]

    @staticmethod
    def mark_seated(entry_id: str) -> CashWaitlistResponse:
        """Encerra a espera depois que o jogador comprou as fichas."""
        entrada = CashWaitlistService.get_entry(entry_id)
        resp = supabase.table("cash_waitlist").update({
            "status": "seated", "seated_at": _agora().isoformat(),
        }).eq("id", entry_id).execute()
        return CashWaitlistService._enriquecer(resp.data or [entrada])[0]

    @staticmethod
    def give_up(entry_id: str, no_show: bool = False) -> CashWaitlistResponse:
        """Sai da fila — por desistência ou por não aparecer quando chamado.

        Os dois estados são separados de propósito: `no_show` é o que explica ao
        próximo da fila por que ele passou na frente de alguém.
        """
        entrada = CashWaitlistService._esperando(entry_id)
        CashWaitlistService._liberar_reserva(entrada)
        resp = supabase.table("cash_waitlist").update({
            "status": "no_show" if no_show else "cancelled",
        }).eq("id", entry_id).execute()
        return CashWaitlistService._enriquecer(resp.data or [entrada])[0]

    @staticmethod
    def update(entry_id: str, data: CashWaitlistUpdate) -> CashWaitlistResponse:
        entrada = CashWaitlistService._esperando(entry_id)
        mudancas = data.model_dump(exclude_unset=True)
        if not mudancas:
            return CashWaitlistService._enriquecer([entrada])[0]
        resp = supabase.table("cash_waitlist").update(mudancas).eq("id", entry_id).execute()
        return CashWaitlistService._enriquecer(resp.data or [entrada])[0]

    # ============================================================
    # Apoio
    # ============================================================

    @staticmethod
    def _esperando(entry_id: str) -> dict:
        entrada = CashWaitlistService.get_entry(entry_id)
        if entrada.get("status") not in ESPERANDO:
            raise ErroDeNegocio(
                "fila_registro_encerrado",
                "Este registro da fila já foi encerrado.",
                status=409, status_atual=entrada.get("status"),
            )
        return entrada

    @staticmethod
    def _liberar_reserva(entrada: dict) -> None:
        if not entrada.get("seat_id"):
            return
        # Só devolve a cadeira se ela AINDA estiver reservada: se o jogador já
        # sentou, marcar 'free' derrubaria a sessão dele da tela.
        supabase.table("cash_seats").update({
            "status": "free", "reserved_for": None, "reserved_until": None,
            "updated_at": _agora().isoformat(),
        }).eq("id", entrada["seat_id"]).eq("status", "reserved").execute()

    @staticmethod
    def release_expired(cash_day_id: str) -> int:
        """Devolve à sala as cadeiras cuja reserva venceu.

        Chamada na leitura da fila, e não por um job: o clube não tem agendador,
        e uma cadeira presa por uma chamada esquecida é um lugar que a sala
        perde a noite inteira. O custo é uma consulta por carregamento.
        """
        agora = _agora().isoformat()
        mesas = supabase.table("cash_tables").select("id") \
            .eq("cash_day_id", cash_day_id).neq("status", "closed").execute().data or []
        if not mesas:
            return 0
        vencidas = supabase.table("cash_seats").select("id") \
            .in_("table_id", [m["id"] for m in mesas]) \
            .eq("status", "reserved").lte("reserved_until", agora).execute().data or []
        for a in vencidas:
            supabase.table("cash_seats").update({
                "status": "free", "reserved_for": None, "reserved_until": None,
                "updated_at": agora,
            }).eq("id", a["id"]).execute()
        return len(vencidas)
