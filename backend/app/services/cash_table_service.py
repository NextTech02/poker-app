"""Mesas de cash game: abrir, acompanhar e fechar apurando o rake.

FECHAR A MESA É O MOMENTO EM QUE A RECEITA VIRA NÚMERO. O sistema não vê mão a
mão — sem sensor na mesa, não há como calcular rake por pote. Quem corta é o
sangeur, em fichas, e o que existe de verdade é a CONTAGEM da caixa de rake:
lançamentos parciais ao longo da noite e um fechamento no fim.

O SNAPSHOT: a mesa copia stakes, buy-in e rake da modalidade na abertura. Ler
sempre pela FK seria mais curto e estaria errado — mudar o rake da modalidade
amanhã reescreveria a apuração das mesas de ontem, e o fechamento que o
operador assinou deixaria de bater.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    CashRakeEntryCreate,
    CashRakeEntryResponse,
    CashSeatResponse,
    CashTableClose,
    CashTableCreate,
    CashTableResponse,
    CashTableUpdate,
)
from app.services.cash_day_service import CashDayService
from app.services.cash_game_type_service import CashGameTypeService
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

# Campos copiados da modalidade para a mesa na abertura.
_SNAPSHOT = (
    "game_variant", "small_blind", "big_blind", "ante",
    "min_buy_in", "max_buy_in", "rake_percent", "rake_cap", "jackpot_per_pot",
)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


class CashTableService:

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def get_table(table_id: str) -> dict:
        resp = supabase.table("cash_tables").select("*").eq("id", table_id).execute()
        if not resp.data:
            raise ErroDeNegocio("mesa_nao_encontrada", "Mesa não encontrada.", status=404)
        return resp.data[0]

    @staticmethod
    def list_tables(
        cash_day_id: Optional[str] = None,
        status: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> List[CashTableResponse]:
        query = supabase.table("cash_tables").select("*")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        if status:
            query = query.eq("status", status)
        if organization_id:
            query = query.eq("organization_id", organization_id)
        mesas = query.order("table_number").execute().data or []
        if not mesas:
            return []
        return CashTableService._enriquecer(mesas)

    @staticmethod
    def _enriquecer(mesas: List[dict]) -> List[CashTableResponse]:
        """Agrega ocupação, dinheiro e rake das mesas em TRÊS consultas.

        A tela do salão recarrega a cada 5s com várias mesas abertas; uma
        consulta por mesa (o N+1 clássico deste projeto) multiplicaria isso
        pelo número de mesas a cada ciclo.
        """
        ids = [m["id"] for m in mesas]

        sessoes = supabase.table("cash_player_sessions").select(
            "table_id, status, total_buy_in, total_cash_out"
        ).in_("table_id", ids).execute().data or []

        rakes = supabase.table("cash_rake_entries").select(
            "table_id, rake_amount, jackpot_amount"
        ).in_("table_id", ids).execute().data or []

        tipos_ids = list({m["game_type_id"] for m in mesas if m.get("game_type_id")})
        nomes = {}
        if tipos_ids:
            linhas = supabase.table("cash_game_types").select("id, name") \
                .in_("id", tipos_ids).execute().data or []
            nomes = {r["id"]: r.get("name") for r in linhas}

        por_mesa: dict = {i: {"ocupados": 0, "entradas": 0.0, "saidas": 0.0,
                              "rake": 0.0, "jackpot": 0.0} for i in ids}
        for s in sessoes:
            alvo = por_mesa.get(s["table_id"])
            if alvo is None:
                continue
            if s.get("status") == "active":
                alvo["ocupados"] += 1
            alvo["entradas"] += float(s.get("total_buy_in") or 0)
            alvo["saidas"] += float(s.get("total_cash_out") or 0)
        for r in rakes:
            alvo = por_mesa.get(r["table_id"])
            if alvo is None:
                continue
            alvo["rake"] += float(r.get("rake_amount") or 0)
            alvo["jackpot"] += float(r.get("jackpot_amount") or 0)

        saida = []
        for m in mesas:
            agg = por_mesa[m["id"]]
            saida.append(CashTableResponse(
                **m,
                game_type_name=nomes.get(m.get("game_type_id")),
                occupied_seats=agg["ocupados"],
                free_seats=max(0, int(m["seats"]) - agg["ocupados"]),
                total_buy_ins=round(agg["entradas"], 2),
                total_cash_outs=round(agg["saidas"], 2),
                rake_partial=round(agg["rake"], 2),
                jackpot_partial=round(agg["jackpot"], 2),
            ))
        return saida

    @staticmethod
    def get_table_enriched(table_id: str) -> CashTableResponse:
        return CashTableService._enriquecer([CashTableService.get_table(table_id)])[0]

    # ============================================================
    # Abertura
    # ============================================================

    @staticmethod
    def open_table(
        data: CashTableCreate,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> CashTableResponse:
        CashDayService.require_open_day(data.cash_day_id)
        tipo = CashGameTypeService.get_type(data.game_type_id)

        ocupado = supabase.table("cash_tables").select("id") \
            .eq("cash_day_id", data.cash_day_id) \
            .eq("table_number", data.table_number) \
            .neq("status", "closed").limit(1).execute()
        if ocupado.data:
            # O número identifica a mesa NO SALÃO. Duas mesas 3 abertas ao mesmo
            # tempo fariam o operador levar fichas para a errada.
            raise ErroDeNegocio(
                "numero_de_mesa_em_uso",
                "Já existe uma mesa aberta com este número.",
                status=409,
                table_number=data.table_number,
            )

        payload = {
            "cash_day_id": data.cash_day_id,
            "game_type_id": data.game_type_id,
            "table_number": data.table_number,
            "seats": data.seats or int(tipo.get("default_seats") or 9),
            "status": "open",
            "opened_by": auth_user_id,
            "notes": data.notes,
        }
        payload.update({campo: tipo.get(campo) for campo in _SNAPSHOT})
        if organization_id:
            payload["organization_id"] = organization_id

        resp = supabase.table("cash_tables").insert(payload).execute()
        # Os assentos são criados pelo trigger `cash_seed_seats` — uma segunda
        # chamada daqui poderia falhar no meio e deixar mesa sem cadeira.
        return CashTableService._enriquecer(resp.data)[0]

    @staticmethod
    def update_table(table_id: str, data: CashTableUpdate) -> CashTableResponse:
        mesa = CashTableService.get_table(table_id)
        if mesa.get("status") == "closed":
            raise ErroDeNegocio("mesa_ja_fechada", "Esta mesa já foi fechada.", status=409)

        mudancas = data.model_dump(exclude_unset=True)
        if not mudancas:
            return CashTableService._enriquecer([mesa])[0]

        novo_numero = mudancas.get("table_number")
        if novo_numero and novo_numero != mesa["table_number"]:
            ocupado = supabase.table("cash_tables").select("id") \
                .eq("cash_day_id", mesa["cash_day_id"]) \
                .eq("table_number", novo_numero) \
                .neq("status", "closed").limit(1).execute()
            if ocupado.data:
                raise ErroDeNegocio(
                    "numero_de_mesa_em_uso",
                    "Já existe uma mesa aberta com este número.",
                    status=409, table_number=novo_numero,
                )

        novos_lugares = mudancas.get("seats")
        if novos_lugares:
            CashTableService._ajustar_assentos(table_id, mesa, int(novos_lugares))

        resp = supabase.table("cash_tables").update(mudancas).eq("id", table_id).execute()
        return CashTableService._enriquecer(resp.data)[0]

    @staticmethod
    def _ajustar_assentos(table_id: str, mesa: dict, novos: int) -> None:
        """Muda o tamanho da mesa sem derrubar quem está sentado.

        Diminuir só remove cadeiras LIVRES. Tirar uma cadeira ocupada apagaria
        a ligação com a sessão do jogador — ele continuaria na mesa física com
        as fichas dele e sumiria da tela.
        """
        atuais = supabase.table("cash_seats").select("id, seat_number, status") \
            .eq("table_id", table_id).execute().data or []
        atual_max = max((int(a["seat_number"]) for a in atuais), default=0)

        if novos > atual_max:
            org = mesa.get("organization_id")
            novas = [{"table_id": table_id, "seat_number": n, "status": "free",
                      **({"organization_id": org} if org else {})}
                     for n in range(atual_max + 1, novos + 1)]
            if novas:
                supabase.table("cash_seats").insert(novas).execute()
            return

        sobrando = [a for a in atuais if int(a["seat_number"]) > novos]
        ocupadas = [a for a in sobrando if a.get("status") != "free"]
        if ocupadas:
            raise ErroDeNegocio(
                "assento_ocupado",
                "Há jogadores nas cadeiras que seriam removidas.",
                status=409,
                assentos=sorted(int(a["seat_number"]) for a in ocupadas),
            )
        for a in sobrando:
            supabase.table("cash_seats").delete().eq("id", a["id"]).execute()

    # ============================================================
    # Apuração de rake
    # ============================================================

    @staticmethod
    def add_rake_entry(
        table_id: str,
        data: CashRakeEntryCreate,
        auth_user_id: Optional[str] = None,
        kind: str = "partial",
        organization_id: Optional[str] = None,
    ) -> CashRakeEntryResponse:
        """Lança uma contagem da caixa de rake da mesa.

        Não mexe no saldo do caixa DE PROPÓSITO: o rake sai do pote, em fichas,
        e já está na gaveta como a diferença entre buy-ins e cash-outs.
        Lançá-lo como movimento contaria o mesmo dinheiro duas vezes.
        """
        mesa = CashTableService.get_table(table_id)
        if kind == "partial" and mesa.get("status") == "closed":
            raise ErroDeNegocio(
                "mesa_ja_fechada",
                "A mesa já foi fechada; a apuração dela está encerrada.",
                status=409,
            )
        if data.rake_amount <= 0 and data.jackpot_amount <= 0:
            raise ErroDeNegocio(
                "apuracao_vazia",
                "Informe o rake ou o jackpot contado.",
            )

        payload = {
            "cash_day_id": mesa["cash_day_id"],
            "table_id": table_id,
            "kind": kind,
            "rake_amount": data.rake_amount,
            "jackpot_amount": data.jackpot_amount,
            "counted_by": auth_user_id,
            "notes": data.notes,
        }
        org = organization_id or mesa.get("organization_id")
        if org:
            payload["organization_id"] = org

        try:
            resp = supabase.table("cash_rake_entries").insert(payload).execute()
        except Exception as exc:
            if kind == "closing" and (
                "duplicate key" in str(exc).lower() or "23505" in str(exc)
            ):
                raise ErroDeNegocio(
                    "rake_ja_apurado",
                    "Esta mesa já teve o rake apurado no fechamento.",
                    status=409, table_id=table_id,
                )
            raise
        return CashRakeEntryResponse(**resp.data[0])

    @staticmethod
    def list_rake_entries(table_id: str) -> List[CashRakeEntryResponse]:
        resp = supabase.table("cash_rake_entries").select("*") \
            .eq("table_id", table_id).order("counted_at").execute()
        return [CashRakeEntryResponse(**r) for r in (resp.data or [])]

    # ============================================================
    # Fechamento
    # ============================================================

    @staticmethod
    def close_table(
        table_id: str,
        data: CashTableClose,
        auth_user_id: Optional[str] = None,
    ) -> CashTableResponse:
        mesa = CashTableService.get_table(table_id)
        if mesa.get("status") == "closed":
            raise ErroDeNegocio("mesa_ja_fechada", "Esta mesa já foi fechada.", status=409)

        sentados = supabase.table("cash_player_sessions").select("id, seat_number") \
            .eq("table_id", table_id).eq("status", "active").execute().data or []
        if sentados:
            # Fechar com gente sentada deixaria fichas compradas sem cash-out:
            # o jogador ficaria devendo ou credor sem registro, e a variância da
            # mesa apontaria um rombo que não existe.
            raise ErroDeNegocio(
                "mesa_com_jogador_sentado",
                "Levante todos os jogadores antes de fechar a mesa.",
                status=409,
                quantidade=len(sentados),
                assentos=sorted(int(s["seat_number"]) for s in sentados),
            )

        CashTableService.add_rake_entry(
            table_id,
            CashRakeEntryCreate(
                rake_amount=data.rake_amount,
                jackpot_amount=data.jackpot_amount,
                notes=data.notes,
            ),
            auth_user_id=auth_user_id,
            kind="closing",
        )

        # `rake_counted` é o TOTAL da mesa (parciais + fechamento), não só o que
        # veio agora — é o número que o relatório da mesa mostra.
        totais = CashTableService.list_rake_entries(table_id)
        rake_total = round(sum(float(t.rake_amount) for t in totais), 2)
        jackpot_total = round(sum(float(t.jackpot_amount) for t in totais), 2)

        resp = supabase.table("cash_tables").update({
            "status": "closed",
            "closed_at": _agora(),
            "closed_by": auth_user_id,
            "rake_counted": rake_total,
            "jackpot_counted": jackpot_total,
        }).eq("id", table_id).execute()

        # As cadeiras somem junto com a mesa (CASCADE); marcá-las livres aqui
        # deixaria a tela mostrar mesa fechada com lugares disponíveis.
        supabase.table("cash_seats").update({"status": "blocked", "updated_at": _agora()}) \
            .eq("table_id", table_id).execute()

        return CashTableService._enriquecer(resp.data)[0]

    # ============================================================
    # Assentos
    # ============================================================

    @staticmethod
    def list_seats(table_id: str) -> List[CashSeatResponse]:
        assentos = supabase.table("cash_seats").select("*") \
            .eq("table_id", table_id).order("seat_number").execute().data or []
        if not assentos:
            return []

        sessao_ids = [a["player_session_id"] for a in assentos if a.get("player_session_id")]
        sessoes: dict = {}
        jogadores: dict = {}
        if sessao_ids:
            linhas = supabase.table("cash_player_sessions").select(
                "id, player_id, total_buy_in, started_at"
            ).in_("id", sessao_ids).execute().data or []
            sessoes = {r["id"]: r for r in linhas}
            jogador_ids = list({r["player_id"] for r in linhas if r.get("player_id")})
            if jogador_ids:
                nomes = supabase.table("players").select("id, name, nickname") \
                    .in_("id", jogador_ids).execute().data or []
                jogadores = {r["id"]: (r.get("nickname") or r.get("name")) for r in nomes}

        saida = []
        for a in assentos:
            sessao = sessoes.get(a.get("player_session_id")) or {}
            saida.append(CashSeatResponse(
                **a,
                player_id=sessao.get("player_id"),
                player_name=jogadores.get(sessao.get("player_id")),
                total_buy_in=(
                    float(sessao["total_buy_in"]) if sessao.get("total_buy_in") is not None else None
                ),
                seated_at=sessao.get("started_at"),
            ))
        return saida
