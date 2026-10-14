"""
Reexecução da fila offline (`POST /sync/batch`). Recebe as operações em ORDEM e
despacha cada uma para o service correspondente — que já é IDEMPOTENTE (pré-checa
o id gerado no cliente). Não reimplementa regra de negócio.

Status por op:
  - applied  : aplicada com sucesso (ou já existia — idempotente).
  - conflict : violou uma regra de negócio (dia cheio, duplicado, saldo, limite de
               rebuy) — vai para a tela de conflitos do operador.
  - error    : falha transitória — o cliente mantém pendente e tenta de novo.
"""
# O ledger `sync_mutations` é deny-all no RLS (só service_role enxerga), então
# este service usa o client admin explicitamente. As operações que ele despacha
# continuam passando pelos services normais, que rodam como o usuário.
import logging

from app.database.supabase_client import supabase_admin as supabase

logger = logging.getLogger("uvicorn.error")
from app.services.tournament_player_service import TournamentPlayerService
from app.services.cash_register_service import CashRegisterService
from app.services.tournament_day_service import TournamentDayService
from app.services.player_service import PlayerService
from app.models.tournament_player import TournamentPlayerCreate
from app.models.cash_register import SangriaTransactionCreate
from app.models.player import PlayerCreate, PlayerUpdate


class SyncService:
    @staticmethod
    def _ledger_seen(client_mutation_id: str) -> bool:
        """True se este client_mutation_id já foi aplicado (idempotência genérica)."""
        if not client_mutation_id:
            return False
        try:
            r = supabase.table("sync_mutations").select("client_mutation_id").eq("client_mutation_id", client_mutation_id).execute()
            return bool(r.data)
        except Exception:
            return False

    @staticmethod
    def _ledger_record(client_mutation_id: str, kind: str, org_id: str | None = None) -> None:
        """Registra a mutação no ledger (idempotência entre dispositivos).

        `organization_id` vai EXPLÍCITO: este service usa o client admin
        (sync_mutations é deny-all no RLS), que não carrega o claim do JWT —
        então o DEFAULT `current_org_id()` resolveria NULL e o INSERT violaria o
        NOT NULL. O erro era engolido pelo `except` abaixo, o que fazia o ledger
        NUNCA registrar nada: o sync parecia funcionar, mas a garantia de
        idempotência não existia na prática.
        """
        if not client_mutation_id:
            return
        row = {"client_mutation_id": client_mutation_id, "kind": kind}
        if org_id:
            row["organization_id"] = org_id
        try:
            supabase.table("sync_mutations").upsert(
                row, on_conflict="client_mutation_id",
            ).execute()
        except Exception as exc:
            # Não derruba o batch (a operação em si já foi aplicada), mas para de
            # falhar em silêncio — sem log, um ledger quebrado passa despercebido.
            logger.warning("Falha ao registrar no ledger de sync (%s): %s", client_mutation_id, exc)

    @staticmethod
    def _apply_timer(p: dict) -> None:
        day_id = p["day_id"]
        action = p.get("action")
        if action == "start":
            TournamentDayService.start_timer(day_id)
        elif action == "pause":
            TournamentDayService.pause_timer(day_id)
        elif action == "next-level":
            TournamentDayService.next_level(day_id)
        elif action == "prev-level":
            TournamentDayService.previous_level(day_id)
        elif action == "adjust":
            TournamentDayService.adjust_timer(day_id, int(p.get("seconds") or 0))
        elif action == "reset":
            TournamentDayService.reset_timer(day_id)
        else:
            raise ValueError(f"Ação de timer desconhecida: {action}")

    @staticmethod
    def apply_op(op: dict, user_id: str, org_id: str | None = None) -> dict:
        kind = op.get("kind")
        p = op.get("body") or {}
        cmid = op.get("clientMutationId")
        out = {"clientMutationId": cmid, "kind": kind}
        try:
            # Idempotência genérica: se já aplicamos este cmid, pula.
            if SyncService._ledger_seen(cmid):
                out.update(status="applied")
                return out
            if kind == "register":
                # skip_sales_block: a venda aconteceu em tempo real, ANTES de o
                # diretor bloquear. Rejeitá-la agora perderia dinheiro que já
                # está na gaveta do operador — mesma razão do skip_level_gate.
                # permitir_meio_inativo: o meio de entrada estava ativo quando a
                # venda saiu no balcão; se o clube o desativou antes do sync,
                # recusar agora criaria um conflito sem solução.
                tp = TournamentPlayerService.register_player(
                    TournamentPlayerCreate(**p), user_id, skip_sales_block=True,
                    permitir_meio_inativo=True,
                )
                out.update(status="applied", serverId=tp.id)
            elif kind == "rebuy":
                TournamentPlayerService.add_rebuy(
                    p["tournament_player_id"], user_id,
                    payment_source=p.get("payment_source", "cash"),
                    payment_method=p.get("payment_method", "cash"),
                    buy_type_id=p.get("buy_type_id"),
                    client_mutation_id=p.get("client_mutation_id") or cmid,
                    skip_level_gate=True,  # offline: feito em tempo real; não re-gatear no sync
                    skip_sales_block=True,
                    permitir_meio_inativo=True,
                    # A reentrada foi vendida quando havia eliminado para
                    # voltar; recusar no sync deixaria dinheiro sem venda.
                    skip_elimination_gate=True,
                )
                out.update(status="applied")
            elif kind == "addon":
                TournamentPlayerService.add_addon(
                    p["tournament_player_id"], user_id,
                    payment_source=p.get("payment_source", "cash"),
                    payment_method=p.get("payment_method", "cash"),
                    buy_type_id=p.get("buy_type_id"),
                    client_mutation_id=p.get("client_mutation_id") or cmid,
                    skip_sales_block=True,
                    permitir_meio_inativo=True,
                )
                out.update(status="applied")
            elif kind == "eliminate":
                # Quem eliminou (torneio KO) vem no corpo da fila; o KO é
                # registrado aqui, no sync — e no Mystery, o envelope sorteado.
                TournamentPlayerService.eliminate_player(
                    p["tournament_player_id"], user_id, idempotent=True,
                    eliminated_by=p.get("eliminated_by") or [],
                    no_eliminator=bool(p.get("no_eliminator")),
                    client_mutation_id=p.get("client_mutation_id") or cmid,
                )
                out.update(status="applied")
            elif kind == "restore":
                # Desfazer eliminação: o contador do dia volta junto.
                TournamentPlayerService.uneliminate_player(
                    p["tournament_player_id"], idempotent=True
                )
                out.update(status="applied")
            elif kind == "sangria":
                CashRegisterService.perform_sangria(SangriaTransactionCreate(**p), user_id)
                out.update(status="applied")
            elif kind == "timer":
                SyncService._apply_timer(p)
                out.update(status="applied")
            elif kind == "elim-counter":
                TournamentDayService.adjust_eliminations(p["day_id"], int(p.get("count") or 0))
                out.update(status="applied")
            elif kind == "player-create":
                pl = PlayerService.create_player(PlayerCreate(**p))
                out.update(status="applied", serverId=pl.id)
            elif kind == "player-update":
                PlayerService.update_player(p["player_id"], PlayerUpdate(**{k: v for k, v in p.items() if k != "player_id"}))
                out.update(status="applied")
            else:
                out.update(status="error", error=f"kind desconhecido: {kind}")
            # Sucesso → registra no ledger (idempotência p/ ops sem linha âncora).
            if out.get("status") == "applied":
                SyncService._ledger_record(cmid, kind, org_id)
        except ValueError as e:
            out.update(status="conflict", error=str(e))
        except Exception as e:  # noqa: BLE001
            out.update(status="error", error=str(e))
        return out

    @staticmethod
    def apply_batch(ops: list, user_id: str, org_id: str | None = None) -> list:
        return [SyncService.apply_op(op, user_id, org_id) for op in (ops or [])]
