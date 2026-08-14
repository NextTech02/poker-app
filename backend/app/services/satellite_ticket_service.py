from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.models.satellite_ticket import (
    TicketBulkCreate,
    TicketBulkResult,
    TicketBulkSkipped,
    TicketCreate,
    TicketResponse,
    TicketSummary,
    TicketTransfer,
    TicketTransferEntry,
)


# Só existe UM cenário em que faz sentido mandar o clube rodar a migração: a
# tabela de histórico não existe naquele banco. Qualquer outra falha (FK, RLS,
# rede) precisa chegar ao suporte com o motivo real, senão a investigação
# começa por uma migração que já está aplicada.
_SINAIS_DE_TABELA_AUSENTE = (
    "undefined_table",
    "42p01",
    "does not exist",
    "não existe",
    "could not find the table",
)


def _falta_a_tabela_de_transferencias(erro: Exception) -> bool:
    partes = [str(erro)]
    for atributo in ("code", "message", "details", "hint"):
        valor = getattr(erro, atributo, None)
        if valor:
            partes.append(str(valor))
    blob = " ".join(partes).lower()
    if "satellite_ticket_transfers" not in blob and "42p01" not in blob:
        return False
    return any(sinal in blob for sinal in _SINAIS_DE_TABELA_AUSENTE)


def _o_banco_recusou_a_coluna(col: str, msg: str, rows: List[dict]) -> bool:
    """A coluna aparece no erro do insert E está sendo enviada nas linhas."""
    return col in msg and any(col in r for r in rows)


def _tirar_coluna_guardando_o_texto(col: str, rows: List[dict], note_lines: List[List[str]]) -> None:
    """Remove a coluna de cada linha e guarda o valor como texto para `notes`."""
    for i, row in enumerate(rows):
        val = row.pop(col, None)
        if val:
            prefix = "Ganho em" if col == "won_at" else "Financiado por"
            note_lines[i].append(f"{prefix}: {val}")


def _gravar_textos_em_notes(rows: List[dict], note_lines: List[List[str]]) -> None:
    """Junta os textos guardados na coluna `notes`, sem perder o que já havia."""
    for i, row in enumerate(rows):
        if not note_lines[i]:
            continue
        existing = (row.get("notes") or "").strip()
        merged = " | ".join(note_lines[i])
        row["notes"] = f"{existing} | {merged}".strip(" |") if existing else merged


class SatelliteTicketService:

    # ================================================
    # Create Ticket — simplified flow
    # ================================================

    @staticmethod
    def create_ticket(data: TicketCreate, user_id: str) -> TicketResponse:
        """Create a ticket already bound to a player, a target tournament and
        a target tournament day. The value is derived from the day's buy_in."""
        # Validate target tournament and target day (day carries the buy-in)
        target_name, ticket_value, target_day_name = \
            SatelliteTicketService._validar_destino_da_vaga(data)

        # Validate player
        player = supabase.table("players").select("name, nickname") \
            .eq("id", data.player_id).execute()
        if not player.data:
            raise ValueError("Jogador não encontrado")

        # Legacy column `satellite_name` is still NOT NULL until the
        # `database_migration_ticket_simplified.sql` migration runs in prod.
        # Auto-fill it with a derived label so the simplified flow works
        # before/after the migration.
        derived_label = SatelliteTicketService._rotulo_legado_do_satelite(target_name, target_day_name)

        won_at_clean = (data.won_at or "").strip()
        funded_by_clean = (data.funded_by or "").strip()

        insert_data = {
            "satellite_name": derived_label,
            "target_tournament_id": data.target_tournament_id,
            "target_tournament_day_id": data.target_tournament_day_id,
            "player_id": data.player_id,
            "ticket_value": ticket_value,
            "status": "awarded",
            "won_at": won_at_clean,
            "funded_by": funded_by_clean,
            "stage_id": data.stage_id,
            "created_by": user_id,
        }

        item = SatelliteTicketService._insert_tickets([insert_data])[0]
        # Surface the original values even if they were stashed into notes
        SatelliteTicketService._repor_origem_e_financiador(item, won_at_clean, funded_by_clean)

        return TicketResponse(
            **item,
            player_name=player.data[0].get("name"),
            player_nickname=player.data[0].get("nickname"),
            target_tournament_name=target_name,
            target_day_name=target_day_name,
        )

    @staticmethod
    def _insert_tickets(rows: List[dict]) -> List[dict]:
        """Insere ticket(s) tolerando banco ainda sem `won_at`/`funded_by`.

        O insert em LOTE no Postgres é tudo-ou-nada: uma coluna inexistente
        derruba as 40 linhas juntas. Quando isso acontece, os dois campos viram
        texto em `notes` — de onde veio a vaga e quem a banca é o que permite
        cobrar o financiador depois, então esse dado não pode simplesmente
        sumir enquanto a migração não roda.
        """
        try:
            return supabase.table("satellite_tickets").insert(rows).execute().data or []
        except Exception as exc:
            msg = str(exc)
            stripped = False
            note_lines: List[List[str]] = [[] for _ in rows]
            for col in ("won_at", "funded_by"):
                if not _o_banco_recusou_a_coluna(col, msg, rows):
                    continue
                stripped = True
                _tirar_coluna_guardando_o_texto(col, rows, note_lines)
            if not stripped:
                raise
            _gravar_textos_em_notes(rows, note_lines)
            return supabase.table("satellite_tickets").insert(rows).execute().data or []

    @staticmethod
    def _validar_destino_da_vaga(data):
        """Confere torneio e dia de destino e devolve (nome do torneio, valor, nome do dia).

        O valor da vaga é o buy-in do DIA — é a entrada que o ticket paga lá na
        frente. Serve tanto para a emissão avulsa quanto para o lote.
        """
        target = supabase.table("tournaments").select("name") \
            .eq("id", data.target_tournament_id).execute()
        if not target.data:
            raise ValueError("Torneio alvo não encontrado")

        day = supabase.table("tournament_days") \
            .select("buy_in, day_name, tournament_id") \
            .eq("id", data.target_tournament_day_id).execute()
        if not day.data:
            raise ValueError("Dia do torneio não encontrado")
        if day.data[0]["tournament_id"] != data.target_tournament_id:
            raise ValueError("O dia selecionado não pertence ao torneio alvo")
        ticket_value = float(day.data[0]["buy_in"] or 0)
        target_day_name = day.data[0].get("day_name")
        return target.data[0]["name"], ticket_value, target_day_name

    @staticmethod
    def _rotulo_legado_do_satelite(target_name: str, target_day_name: Optional[str]) -> str:
        """Texto para a coluna legada `satellite_name` (torneio — dia)."""
        derived_label_parts = [target_name]
        if target_day_name:
            derived_label_parts.append(target_day_name)
        return " — ".join(derived_label_parts)

    @staticmethod
    def _repor_origem_e_financiador(item: dict, won_at_clean: str, funded_by_clean: str) -> None:
        """Mostra os valores originais mesmo quando foram parar em `notes`."""
        if not item.get("won_at"):
            item["won_at"] = won_at_clean or None
        if not item.get("funded_by"):
            item["funded_by"] = funded_by_clean or None

    @staticmethod
    def _separar_jogadores_do_lote(player_ids: List[str]):
        """Separa quem recebe vaga de quem fica de fora, devolvendo
        (válidos, jogadores por id, ignorados).

        Jogador repetido no payload é erro de seleção na tela, não intenção de
        dar duas vagas — emitir as duas seria dinheiro dobrado no pool sem
        ninguém ter pedido. Os jogadores são buscados numa consulta só: com 100
        jogadores, validar um a um seriam 200 idas ao banco remoto.
        """
        skipped: List[TicketBulkSkipped] = []

        vistos = set()
        ordenados: List[str] = []
        for pid in player_ids:
            if pid in vistos:
                skipped.append(TicketBulkSkipped(player_id=pid, reason="duplicado_no_lote"))
                continue
            vistos.add(pid)
            ordenados.append(pid)

        encontrados = supabase.table("players").select("id, name, nickname") \
            .in_("id", ordenados).execute()
        por_id = {p["id"]: p for p in (encontrados.data or [])}

        validos = []
        for pid in ordenados:
            if pid in por_id:
                validos.append(pid)
            else:
                skipped.append(TicketBulkSkipped(player_id=pid, reason="jogador_nao_encontrado"))

        return validos, por_id, skipped

    # ================================================
    # Bulk Create — restrito ao "master" do clube
    # ================================================

    @staticmethod
    def create_tickets_bulk(data: TicketBulkCreate, user_id: str) -> TicketBulkResult:
        """Emite a MESMA vaga (torneio + dia) para vários jogadores de uma vez.

        É o fechamento de um satélite: todos os classificados recebem a entrada
        do dia-destino. O destino é validado UMA vez e os jogadores são buscados
        numa consulta só — com 100 jogadores, validar um a um seriam 200 idas ao
        banco remoto.

        Jogador inexistente ou repetido no payload não derruba o lote: ele volta
        em `skipped` para o operador resolver na mão, e os demais são emitidos.
        """
        target_name, ticket_value, target_day_name = \
            SatelliteTicketService._validar_destino_da_vaga(data)

        validos, por_id, skipped = \
            SatelliteTicketService._separar_jogadores_do_lote(data.player_ids)

        if not validos:
            raise ValueError("Nenhum jogador válido no lote")

        derived_label = SatelliteTicketService._rotulo_legado_do_satelite(target_name, target_day_name)

        won_at_clean = (data.won_at or "").strip()
        funded_by_clean = (data.funded_by or "").strip()

        linhas = [{
            "satellite_name": derived_label,
            "target_tournament_id": data.target_tournament_id,
            "target_tournament_day_id": data.target_tournament_day_id,
            "player_id": pid,
            "ticket_value": ticket_value,
            "status": "awarded",
            "won_at": won_at_clean,
            "funded_by": funded_by_clean,
            "stage_id": data.stage_id,
            "created_by": user_id,
        } for pid in validos]

        criados_raw = SatelliteTicketService._insert_tickets(linhas)

        criados = []
        for item in criados_raw:
            SatelliteTicketService._repor_origem_e_financiador(item, won_at_clean, funded_by_clean)
            jogador = por_id.get(item.get("player_id"), {})
            criados.append(TicketResponse(
                **item,
                player_name=jogador.get("name"),
                player_nickname=jogador.get("nickname"),
                target_tournament_name=target_name,
                target_day_name=target_day_name,
            ))

        return TicketBulkResult(
            created=criados,
            skipped=skipped,
            total_value=round(ticket_value * len(criados), 2),
        )

    # ================================================
    # Query Tickets
    # ================================================

    @staticmethod
    def get_ticket(ticket_id: str) -> Optional[TicketResponse]:
        response = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        if not response.data:
            return None
        return SatelliteTicketService._enrich_ticket(response.data[0])

    @staticmethod
    def get_all_tickets(
        stage_id: Optional[str] = None,
        status: Optional[str] = None,
        target_tournament_id: Optional[str] = None,
        player_id: Optional[str] = None,
    ) -> List[TicketResponse]:
        query = supabase.table("satellite_tickets").select("*, players(name, nickname)")

        # Perguntar "esse jogador tem vaga?" é uma pergunta GLOBAL: o perfil dele
        # não muda conforme a etapa escolhida na barra de cima. Como o
        # X-Stage-ID viaja em toda requisição, aplicar o recorte de etapa aqui
        # esconderia a vaga que ele ganhou na etapa anterior.
        if stage_id and not player_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")
        if player_id:
            query = query.eq("player_id", player_id)
        if status:
            query = query.eq("status", status)
        if target_tournament_id:
            query = query.eq("target_tournament_id", target_tournament_id)

        response = query.order("created_at", desc=True).execute()
        return SatelliteTicketService._enrich_many(response.data or [])

    @staticmethod
    def get_available_tickets(
        target_tournament_id: Optional[str] = None,
    ) -> List[TicketResponse]:
        """Get all un-redeemed tickets (covers both 'awarded' and the legacy
        'available' status)."""
        query = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .in_("status", ["awarded", "available"])

        if target_tournament_id:
            query = query.eq("target_tournament_id", target_tournament_id)

        response = query.order("created_at").execute()
        return SatelliteTicketService._enrich_many(response.data or [])

    @staticmethod
    def get_summary(stage_id: Optional[str] = None) -> TicketSummary:
        query = supabase.table("satellite_tickets").select("status")
        if stage_id:
            query = query.or_(f"stage_id.eq.{stage_id},stage_id.is.null")

        response = query.execute()
        statuses = [t["status"] for t in (response.data or [])]

        # Backwards compatibility: treat both "awarded" (current schema) and
        # "available" (legacy schema) as the un-redeemed bucket.
        return TicketSummary(
            total_available=statuses.count("awarded") + statuses.count("available"),
            total_redeemed=statuses.count("redeemed"),
            total_cancelled=statuses.count("cancelled"),
        )

    # ================================================
    # Redeem & Cancel
    # ================================================

    @staticmethod
    def redeem_ticket(ticket_id: str, funded_by: Optional[str], user_id: str) -> dict:
        """Redeem a ticket: registers the bound player on the bound day.
        `funded_by` is sourced from the ticket itself (set at creation). The
        argument is only honored for legacy tickets created before that
        field existed at creation time."""
        ticket = supabase.table("satellite_tickets").select("*").eq("id", ticket_id).execute()
        if not ticket.data:
            raise ValueError("Ticket não encontrado")

        t = ticket.data[0]

        if t["status"] not in ("awarded", "available"):
            raise ValueError(f"Ticket não pode ser resgatado (status: {t['status']})")

        player_id = t.get("player_id")
        if not player_id:
            raise ValueError("Este ticket não tem jogador atribuído. Cadastre um novo ticket no formato atual.")

        day_id = t.get("target_tournament_day_id")
        if not day_id:
            raise ValueError("Este ticket não tem dia alvo definido")

        # Prefer the funder set at creation; fall back to the legacy notes
        # encoding ("Financiado por: X"); finally fall back to the payload
        # for tickets that pre-date both.
        ticket_funded = (t.get("funded_by") or "").strip()
        if not ticket_funded and t.get("notes"):
            note_value = t["notes"].strip()
            for prefix in ("Financiado por:",):
                if note_value.lower().startswith(prefix.lower()):
                    ticket_funded = note_value[len(prefix):].strip()
                    break
        funded_by_clean = ticket_funded or (funded_by or "").strip()
        if not funded_by_clean:
            raise ValueError("Informe quem financiou o ticket")

        # Register player using tournament_player_service
        from app.models.tournament_player import TournamentPlayerCreate
        from app.services.tournament_player_service import TournamentPlayerService

        registration = TournamentPlayerCreate(
            tournament_id=t["target_tournament_id"],
            tournament_day_id=day_id,
            player_id=player_id,
            buy_in_count=1,
            payment_source="ticket",
            ticket_id=ticket_id,
            notes=f"Resgate de ticket — financiado por {funded_by_clean}",
        )

        tp = TournamentPlayerService.register_player(registration, user_id)

        # Update ticket. If the `funded_by` column hasn't been added by the
        # migration yet, retry without it and fall back to storing the funder
        # in the existing `notes` column.
        update_payload = {
            "status": "redeemed",
            "funded_by": funded_by_clean,
            "redeemed_at": datetime.now(timezone.utc).isoformat(),
            "redeemed_tournament_player_id": tp.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            supabase.table("satellite_tickets").update(update_payload).eq("id", ticket_id).execute()
        except Exception as e:
            if "funded_by" in str(e):
                update_payload.pop("funded_by", None)
                update_payload["notes"] = f"Financiado por: {funded_by_clean}"
                supabase.table("satellite_tickets").update(update_payload).eq("id", ticket_id).execute()
            else:
                raise

        return {
            "ticket_id": ticket_id,
            "tournament_player_id": tp.id,
            "player_name": tp.player_name,
            "tournament_name": tp.tournament_name,
            "funded_by": funded_by_clean,
            "message": "Ticket resgatado com sucesso",
        }

    @staticmethod
    def cancel_ticket(ticket_id: str, user_id: str) -> TicketResponse:
        ticket = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        if not ticket.data:
            raise ValueError("Ticket não encontrado")

        t = ticket.data[0]
        if t["status"] not in ("awarded", "available"):
            raise ValueError("Apenas tickets ainda não resgatados podem ser cancelados")

        supabase.table("satellite_tickets").update({
            "status": "cancelled",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", ticket_id).execute()

        updated = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        return SatelliteTicketService._enrich_ticket(updated.data[0])

    # ================================================
    # Transferência e venda do ticket
    # ================================================

    @staticmethod
    def _conferir_troca_de_dono(ticket_id: str, data: TicketTransfer):
        """Valida o ticket e o novo dono; devolve (ticket, id do destino, nome do destino)."""
        ticket = supabase.table("satellite_tickets").select("*") \
            .eq("id", ticket_id).execute()
        if not ticket.data:
            raise ValueError("Ticket não encontrado")

        t = ticket.data[0]
        if t["status"] not in ("awarded", "available"):
            raise ValueError("Apenas tickets ainda não resgatados podem ser transferidos")

        destino_id = (data.to_player_id or "").strip()
        if not destino_id:
            raise ValueError("Informe o jogador de destino")
        if t.get("player_id") == destino_id:
            raise ValueError("O ticket já pertence a esse jogador")

        destino = supabase.table("players").select("name") \
            .eq("id", destino_id).execute()
        if not destino.data:
            raise ValueError("Jogador de destino não encontrado")

        return t, destino_id, destino.data[0].get("name")

    @staticmethod
    def _decidir_como_lancar_a_venda(data: TicketTransfer, t: dict, stage_id: Optional[str], org_id: Optional[str]):
        """Diz se a troca é venda ou doação e em que etapa o dinheiro entra.

        Devolve (valor, tipo, lança no caixa?, etapa). A receita mora na etapa
        (other_revenues.stage_id é NOT NULL). Sem etapa, gravar a troca sem o
        dinheiro deixaria a venda invisível no DRE — melhor recusar e pedir a
        etapa.
        """
        valor = float(data.amount or 0)
        tipo = "sale" if valor > 0 else "transfer"
        lanca_no_caixa = tipo == "sale" and bool(data.register_in_cash)

        etapa = stage_id or t.get("stage_id")
        if lanca_no_caixa and not etapa:
            raise ValueError("Selecione uma etapa para lançar a venda no caixa")
        if lanca_no_caixa and not org_id:
            raise ValueError("Sua conta não está vinculada a nenhuma organização.")

        return valor, tipo, lanca_no_caixa, etapa

    @staticmethod
    def _lancar_receita_da_venda(
        org_id: str,
        etapa: str,
        nome_do_destino: Optional[str],
        valor: float,
        payment_method: Optional[str],
        observacao: Optional[str],
        user_id: str,
    ) -> Optional[str]:
        """Entra o dinheiro da venda no caixa da etapa e devolve o id da receita."""
        from app.services.expense_service import ExpenseService

        # SEM torneio de propósito. O dinheiro da venda entra no caixa da
        # etapa em que o caixa está operando (`etapa`), enquanto o
        # torneio-destino da vaga quase sempre pertence a OUTRA etapa.
        # Amarrar a receita ao torneio-destino deixaria a linha com etapa e
        # torneio de etapas diferentes: o DRE filtra por etapa E por torneio
        # juntos (ExpenseService.summarize_revenues), então a venda sumiria
        # do DRE do torneio-destino e ainda apareceria como receita "dele"
        # em qualquer relatório que agrupe só por torneio. A venda da vaga é
        # faturamento da ETAPA, não entrada do torneio-destino.
        receita = ExpenseService.create_revenue(org_id, {
            "stage_id": etapa,
            "source": "Ticket",
            "description": f"Venda de ticket para {nome_do_destino}",
            "amount": valor,
            "status": "recebido",
            "payment_method": payment_method,
            "to_cash": True,
            "notes": observacao,
        }, user_id)
        return (receita or {}).get("id")

    @staticmethod
    def _registrar_troca_no_historico(registro: dict, revenue_id: Optional[str], org_id: Optional[str]) -> None:
        """Grava a linha do histórico; se falhar, estorna a receita já lançada."""
        try:
            supabase.table("satellite_ticket_transfers").insert(registro).execute()
        except Exception as erro:
            # Sem histórico ninguém explica de onde veio o dinheiro. Estorna a
            # receita em vez de deixar o caixa inflado por um lançamento órfão.
            if revenue_id and org_id:
                from app.services.expense_service import ExpenseService
                try:
                    ExpenseService.delete_revenue(org_id, revenue_id)
                except Exception:
                    pass
            # Culpar a migração em QUALQUER falha manda o suporte procurar no
            # lugar errado: em produção a tabela já existe, e o que costuma
            # quebrar aqui é FK inválida, RLS ou rede. Só sugere a migração
            # quando a tabela realmente não existe; no resto, mostra o motivo
            # real para quem estiver com o caixa parado.
            if _falta_a_tabela_de_transferencias(erro):
                raise ValueError(
                    "Não foi possível registrar a transferência do ticket. "
                    "Verifique se a migração de transferência de tickets já foi aplicada."
                )
            raise ValueError(
                f"Não foi possível registrar a transferência do ticket: {erro}"
            )

    @staticmethod
    def transfer_ticket(
        ticket_id: str,
        data: TicketTransfer,
        user_id: str,
        org_id: Optional[str] = None,
        stage_id: Optional[str] = None,
    ) -> TicketResponse:
        """Passa o ticket para outro jogador — de graça ou vendido.

        O ticket só troca de `player_id`: `ticket_value`, `won_at` e `funded_by`
        ficam como estão. Quem BANCA o buy-in no torneio-destino não muda por
        causa da venda — é outro dinheiro, e o resgate depende do financiador
        original para o clube saber de quem cobrar a entrada.
        """
        t, destino_id, nome_do_destino = \
            SatelliteTicketService._conferir_troca_de_dono(ticket_id, data)

        valor, tipo, lanca_no_caixa, etapa = \
            SatelliteTicketService._decidir_como_lancar_a_venda(data, t, stage_id, org_id)

        observacao = (data.notes or "").strip() or None

        revenue_id = None
        if lanca_no_caixa:
            revenue_id = SatelliteTicketService._lancar_receita_da_venda(
                org_id, etapa, nome_do_destino, valor, data.payment_method, observacao, user_id
            )

        registro = {
            "ticket_id": ticket_id,
            "from_player_id": t.get("player_id"),
            "to_player_id": destino_id,
            "kind": tipo,
            "amount": valor,
            "payment_method": data.payment_method,
            "stage_id": etapa,
            "revenue_id": revenue_id,
            "notes": observacao,
            "performed_by": user_id,
        }
        SatelliteTicketService._registrar_troca_no_historico(registro, revenue_id, org_id)

        supabase.table("satellite_tickets").update({
            "player_id": destino_id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", ticket_id).execute()

        atualizado = supabase.table("satellite_tickets").select("*, players(name, nickname)") \
            .eq("id", ticket_id).execute()
        return SatelliteTicketService._enrich_ticket(atualizado.data[0])

    @staticmethod
    def list_transfers(ticket_id: str) -> List[TicketTransferEntry]:
        """Histórico de trocas de dono, do mais recente para o mais antigo.

        Devolve vazio se a tabela ainda não existe: a tela de tickets não pode
        quebrar num cliente que ainda não rodou a migração."""
        try:
            linhas = supabase.table("satellite_ticket_transfers").select("*") \
                .eq("ticket_id", ticket_id).order("created_at", desc=True).execute().data or []
        except Exception:
            return []

        ids = {r.get("from_player_id") for r in linhas} | {r.get("to_player_id") for r in linhas}
        ids.discard(None)
        nomes: dict = {}
        if ids:
            r = supabase.table("players").select("id, name").in_("id", list(ids)).execute()
            nomes = {p["id"]: p.get("name") for p in (r.data or [])}

        return [
            TicketTransferEntry(
                **linha,
                from_player_name=nomes.get(linha.get("from_player_id")),
                to_player_name=nomes.get(linha.get("to_player_id")),
            )
            for linha in linhas
        ]

    # ================================================
    # Helpers
    # ================================================

    @staticmethod
    def _enrich_many(items: List[dict]) -> List[TicketResponse]:
        """Enrich a list of tickets with O(1) extra queries instead of O(N).

        The per-item _enrich_ticket path issues 2 lookups (tournament + day)
        per ticket, i.e. 1 + 2N round-trips to a remote Postgres. Here we
        batch all tournament/day names into 2 `in_` queries and feed them to
        the enricher as maps, so any list size costs at most 3 queries total.
        """
        if not items:
            return []

        tour_ids = {i["target_tournament_id"] for i in items if i.get("target_tournament_id")}
        day_ids = {i["target_tournament_day_id"] for i in items if i.get("target_tournament_day_id")}

        tour_names: dict = {}
        if tour_ids:
            r = supabase.table("tournaments").select("id, name").in_("id", list(tour_ids)).execute()
            tour_names = {t["id"]: t["name"] for t in (r.data or [])}

        day_names: dict = {}
        if day_ids:
            r = supabase.table("tournament_days").select("id, day_name").in_("id", list(day_ids)).execute()
            day_names = {d["id"]: d.get("day_name") for d in (r.data or [])}

        return [
            SatelliteTicketService._enrich_ticket(i, tour_names, day_names)
            for i in items
        ]

    @staticmethod
    def _enrich_ticket(
        item: dict,
        tour_names: Optional[dict] = None,
        day_names: Optional[dict] = None,
    ) -> TicketResponse:
        p = item.pop("players", {}) or {}

        tgt_name = None
        tgt_day_name = None

        tgt_id = item.get("target_tournament_id")
        day_id = item.get("target_tournament_day_id")

        # Use pre-fetched maps when available (list path); otherwise fall back
        # to single lookups (single-item paths: get_ticket / cancel_ticket).
        if tour_names is not None:
            tgt_name = tour_names.get(tgt_id)
        elif tgt_id:
            tgt = supabase.table("tournaments").select("name").eq("id", tgt_id).execute()
            if tgt.data:
                tgt_name = tgt.data[0]["name"]

        if day_names is not None:
            tgt_day_name = day_names.get(day_id)
        elif day_id:
            d = supabase.table("tournament_days").select("day_name") \
                .eq("id", day_id).execute()
            if d.data:
                tgt_day_name = d.data[0].get("day_name")

        # Pre-migration fallback: when the `won_at` / `funded_by` columns
        # don't exist yet, both creation and redemption flows stash the data
        # into `notes` using "Ganho em: X" / "Financiado por: X" prefixes
        # (joined with " | " when both are present). Surface them as proper
        # fields so the UI is consistent across both modes.
        if (not item.get("funded_by") or not item.get("won_at")) and item.get("notes"):
            for chunk in [c.strip() for c in item["notes"].split("|")]:
                if not item.get("funded_by") and chunk.lower().startswith("financiado por:"):
                    item["funded_by"] = chunk.split(":", 1)[1].strip()
                elif not item.get("won_at") and chunk.lower().startswith("ganho em:"):
                    item["won_at"] = chunk.split(":", 1)[1].strip()

        return TicketResponse(
            **item,
            player_name=p.get("name"),
            player_nickname=p.get("nickname"),
            target_tournament_name=tgt_name,
            target_day_name=tgt_day_name,
        )
