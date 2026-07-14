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
from app.services.tournament_player_service import TournamentPlayerService
from app.services.cash_register_service import CashRegisterService
from app.services.tournament_day_service import TournamentDayService
from app.models.tournament_player import TournamentPlayerCreate, TournamentPlayerUpdate
from app.models.cash_register import SangriaTransactionCreate


class SyncService:
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
    def apply_op(op: dict, user_id: str) -> dict:
        kind = op.get("kind")
        p = op.get("body") or {}
        cmid = op.get("clientMutationId")
        out = {"clientMutationId": cmid, "kind": kind}
        try:
            if kind == "register":
                tp = TournamentPlayerService.register_player(TournamentPlayerCreate(**p), user_id)
                out.update(status="applied", serverId=tp.id)
            elif kind == "rebuy":
                TournamentPlayerService.add_rebuy(
                    p["tournament_player_id"], user_id,
                    payment_source=p.get("payment_source", "cash"),
                    payment_method=p.get("payment_method", "cash"),
                    buy_type_id=p.get("buy_type_id"),
                    client_mutation_id=p.get("client_mutation_id") or cmid,
                )
                out.update(status="applied")
            elif kind == "addon":
                TournamentPlayerService.add_addon(
                    p["tournament_player_id"], user_id,
                    payment_source=p.get("payment_source", "cash"),
                    payment_method=p.get("payment_method", "cash"),
                    buy_type_id=p.get("buy_type_id"),
                    client_mutation_id=p.get("client_mutation_id") or cmid,
                )
                out.update(status="applied")
            elif kind == "eliminate":
                TournamentPlayerService.eliminate_player(p["tournament_player_id"], user_id)
                out.update(status="applied")
            elif kind == "restore":
                TournamentPlayerService.update_tournament_player(
                    p["tournament_player_id"], TournamentPlayerUpdate(status="active")
                )
                out.update(status="applied")
            elif kind == "sangria":
                CashRegisterService.perform_sangria(SangriaTransactionCreate(**p), user_id)
                out.update(status="applied")
            elif kind == "timer":
                SyncService._apply_timer(p)
                out.update(status="applied")
            else:
                out.update(status="error", error=f"kind desconhecido: {kind}")
        except ValueError as e:
            out.update(status="conflict", error=str(e))
        except Exception as e:  # noqa: BLE001
            out.update(status="error", error=str(e))
        return out

    @staticmethod
    def apply_batch(ops: list, user_id: str) -> list:
        return [SyncService.apply_op(op, user_id) for op in (ops or [])]
