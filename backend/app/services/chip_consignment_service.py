from typing import List, Optional
from datetime import datetime, timezone
from fastapi import HTTPException, status

from app.database import supabase
from app.models.chip_consignment import (
    ConsignmentRelease,
    ConsignmentResponse,
    SaleCreate,
    SaleResponse,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ChipConsignmentService:

    # ================================================
    # Helpers
    # ================================================

    @staticmethod
    def _staff_for_user(auth_user_id: str) -> Optional[dict]:
        resp = supabase.table("staff").select("id, name, active") \
            .eq("auth_user_id", auth_user_id).execute()
        return resp.data[0] if resp.data else None

    @staticmethod
    def _build(item: dict, with_sales: bool = False) -> ConsignmentResponse:
        sangi = item.pop("staff", None) or {}
        released = float(item.get("released_amount") or 0)
        sold = float(item.get("total_sold") or 0)
        sales = []
        if with_sales:
            sales = ChipConsignmentService.get_sales(item["id"])
        return ConsignmentResponse(
            id=item["id"],
            sangi_staff_id=item["sangi_staff_id"],
            sangi_name=sangi.get("name"),
            stage_id=item["stage_id"],
            released_amount=released,
            total_sold=sold,
            remaining=released - sold,
            divergence=(float(item["divergence"]) if item.get("divergence") is not None else None),
            status=item.get("status", "open"),
            opened_at=item["opened_at"],
            reconciled_at=item.get("reconciled_at"),
            notes=item.get("notes"),
            created_at=item["created_at"],
            sales=sales,
        )

    # ================================================
    # Release (cashier opens a consignment)
    # ================================================

    @staticmethod
    def release(data: ConsignmentRelease, stage_id: Optional[str], opened_by: str) -> ConsignmentResponse:
        effective_stage = data.stage_id or stage_id
        if not effective_stage:
            raise HTTPException(status_code=400, detail="stage_id é obrigatório (selecione uma etapa).")

        # Validate sangi staff exists, is active, and is classified as a sangi.
        # A sangi (chip seller on consignment) is distinct from a cashbox/caixa:
        # only staff whose permission group grants the `sangi` key can receive
        # a consignment. Enforced here so the rule holds even on direct API calls.
        staff = supabase.table("staff").select("id, active, permission_groups(permissions)") \
            .eq("id", data.sangi_staff_id).execute()
        if not staff.data:
            raise HTTPException(status_code=404, detail="Sangeur (funcionário) não encontrada.")
        staff_row = staff.data[0]
        if not staff_row.get("active", True):
            raise HTTPException(status_code=400, detail="Funcionário inativo.")
        group = staff_row.get("permission_groups") or {}
        if "sangi" not in (group.get("permissions") or []):
            raise HTTPException(
                status_code=400,
                detail="Este funcionário não está classificado como Sangeur.",
            )

        # One open consignment per (sangi, stage)
        open_existing = supabase.table("chip_consignments").select("id") \
            .eq("sangi_staff_id", data.sangi_staff_id) \
            .eq("stage_id", effective_stage) \
            .eq("status", "open").execute()
        if open_existing.data:
            raise HTTPException(
                status_code=400,
                detail="Esta sangeur já tem uma consignação aberta nesta etapa. Faça o abate antes de liberar outra."
            )

        insert = {
            "sangi_staff_id": data.sangi_staff_id,
            "stage_id": effective_stage,
            "released_amount": data.released_amount,
            "status": "open",
            "opened_by": opened_by,
            "notes": data.notes,
        }
        resp = supabase.table("chip_consignments").insert(insert).execute()
        return ChipConsignmentService.get(resp.data[0]["id"])

    # ================================================
    # Queries
    # ================================================

    @staticmethod
    def get(consignment_id: str, with_sales: bool = True) -> ConsignmentResponse:
        resp = supabase.table("chip_consignments") \
            .select("*, staff(name)") \
            .eq("id", consignment_id).execute()
        if not resp.data:
            raise HTTPException(status_code=404, detail="Consignação não encontrada.")
        return ChipConsignmentService._build(resp.data[0], with_sales=with_sales)

    @staticmethod
    def list(stage_id: Optional[str] = None, sangi_staff_id: Optional[str] = None,
             status_filter: Optional[str] = None) -> List[ConsignmentResponse]:
        query = supabase.table("chip_consignments").select("*, staff(name)")
        if stage_id:
            query = query.eq("stage_id", stage_id)
        if sangi_staff_id:
            query = query.eq("sangi_staff_id", sangi_staff_id)
        if status_filter:
            query = query.eq("status", status_filter)
        resp = query.order("created_at", desc=True).execute()
        return [ChipConsignmentService._build(i, with_sales=False) for i in (resp.data or [])]

    @staticmethod
    def get_my_open(auth_user_id: str, stage_id: Optional[str] = None) -> Optional[ConsignmentResponse]:
        """For the sangi: the open consignment assigned to them."""
        staff = ChipConsignmentService._staff_for_user(auth_user_id)
        if not staff:
            return None
        query = supabase.table("chip_consignments").select("*, staff(name)") \
            .eq("sangi_staff_id", staff["id"]).eq("status", "open")
        if stage_id:
            query = query.eq("stage_id", stage_id)
        resp = query.order("created_at", desc=True).execute()
        if not resp.data:
            return None
        return ChipConsignmentService._build(resp.data[0], with_sales=True)

    @staticmethod
    def get_sales(consignment_id: str) -> List[SaleResponse]:
        resp = supabase.table("chip_consignment_sales") \
            .select("*, players(name)") \
            .eq("consignment_id", consignment_id) \
            .order("created_at", desc=True).execute()
        out = []
        for s in (resp.data or []):
            player = s.pop("players", None) or {}
            out.append(SaleResponse(
                id=s["id"],
                consignment_id=s["consignment_id"],
                amount=float(s["amount"]),
                buyer_player_id=s["buyer_player_id"],
                buyer_player_name=player.get("name"),
                sold_by=s.get("sold_by"),
                notes=s.get("notes"),
                created_at=s["created_at"],
            ))
        return out

    # ================================================
    # Sale (sangi registers a sale)
    # ================================================

    @staticmethod
    def register_sale(consignment_id: str, data: SaleCreate, sold_by: str,
                      acting_auth_user_id: Optional[str] = None,
                      restrict_to_self: bool = False) -> SaleResponse:
        cons = supabase.table("chip_consignments").select("*") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise HTTPException(status_code=404, detail="Consignação não encontrada.")
        c = cons.data[0]
        if c["status"] != "open":
            raise HTTPException(status_code=400, detail="Consignação já reconciliada; não aceita novas vendas.")

        # When the caller is the sangi, ensure they only sell on their own consignment
        if restrict_to_self and acting_auth_user_id:
            staff = ChipConsignmentService._staff_for_user(acting_auth_user_id)
            if not staff or staff["id"] != c["sangi_staff_id"]:
                raise HTTPException(status_code=403, detail="Você só pode registrar vendas da sua própria consignação.")

        # Buyer must be a registered player
        player = supabase.table("players").select("id, name") \
            .eq("id", data.buyer_player_id).execute()
        if not player.data:
            raise HTTPException(status_code=404, detail="Comprador (jogador) não encontrado.")

        # Optional guard: don't let sales exceed what was released
        new_total = float(c.get("total_sold") or 0) + data.amount
        if new_total > float(c["released_amount"]) + 0.001:
            raise HTTPException(
                status_code=400,
                detail=(f"Venda excede o valor liberado. Liberado: R$ {float(c['released_amount']):.2f}, "
                        f"já vendido: R$ {float(c.get('total_sold') or 0):.2f}.")
            )

        insert = {
            "consignment_id": consignment_id,
            "amount": data.amount,
            "buyer_player_id": data.buyer_player_id,
            "sold_by": sold_by,
            "notes": data.notes,
        }
        # The app-layer check above is a friendly fast-path, but it is not
        # atomic. The DB trigger chip_consignment_apply_sale enforces the cap
        # under concurrency and raises if this sale would oversell. Translate
        # that into a clean 400 (instead of a 500) for the race loser.
        try:
            resp = supabase.table("chip_consignment_sales").insert(insert).execute()
        except Exception as exc:
            msg = str(exc)
            if "excede o valor liberado" in msg or "reconciliada" in msg:
                raise HTTPException(
                    status_code=400,
                    detail="Venda excede o valor liberado para esta consignação.",
                )
            raise
        sale = resp.data[0]
        return SaleResponse(
            id=sale["id"],
            consignment_id=sale["consignment_id"],
            amount=float(sale["amount"]),
            buyer_player_id=sale["buyer_player_id"],
            buyer_player_name=player.data[0].get("name"),
            sold_by=sale.get("sold_by"),
            notes=sale.get("notes"),
            created_at=sale["created_at"],
        )

    @staticmethod
    def delete_sale(consignment_id: str, sale_id: str) -> None:
        cons = supabase.table("chip_consignments").select("status") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise HTTPException(status_code=404, detail="Consignação não encontrada.")
        if cons.data[0]["status"] != "open":
            raise HTTPException(status_code=400, detail="Consignação reconciliada; vendas não podem ser alteradas.")
        supabase.table("chip_consignment_sales").delete() \
            .eq("id", sale_id).eq("consignment_id", consignment_id).execute()

    # ================================================
    # Reconcile (cashier closes / abate)
    # ================================================

    @staticmethod
    def reconcile(consignment_id: str, reconciled_by: str, notes: Optional[str] = None) -> ConsignmentResponse:
        cons = supabase.table("chip_consignments").select("*") \
            .eq("id", consignment_id).execute()
        if not cons.data:
            raise HTTPException(status_code=404, detail="Consignação não encontrada.")
        c = cons.data[0]
        if c["status"] == "reconciled":
            raise HTTPException(status_code=400, detail="Consignação já reconciliada.")

        released = float(c["released_amount"])
        sold = float(c.get("total_sold") or 0)
        divergence = released - sold  # >0 = faltou vender/repor; deve ser 0 quando tudo certo

        update = {
            "status": "reconciled",
            "divergence": divergence,
            "reconciled_by": reconciled_by,
            "reconciled_at": _now(),
            "updated_at": _now(),
        }
        if notes:
            update["notes"] = notes
        supabase.table("chip_consignments").update(update).eq("id", consignment_id).execute()
        return ChipConsignmentService.get(consignment_id)
