from typing import Optional, List
from datetime import datetime, timezone
from app.database import supabase

# Despesas da etapa — alimentam o DRE (ver financial_service).
#
# Escopamos EXPLICITAMENTE pela org do JWT em vez de confiar só no RLS: o backend
# local roda com service_role e queries sem filtro pegariam a organização errada
# (mesma armadilha já encontrada na fidelidade).


def _iso_end_of_day(date_str: str) -> str:
    return datetime.fromisoformat(date_str).replace(hour=23, minute=59, second=59).isoformat()


class ExpenseService:

    # ── Categorias ──────────────────────────────────────────────────────────

    @staticmethod
    def get_categories(org_id: Optional[str], active_only: bool = False) -> List[dict]:
        if not org_id:
            return []
        q = supabase.table("expense_categories").select("*").eq("organization_id", org_id)
        if active_only:
            q = q.eq("active", True)
        return q.order("sort_order").order("name").execute().data or []

    @staticmethod
    def create_category(org_id: str, data: dict) -> dict:
        payload = {**data, "organization_id": org_id}
        return (supabase.table("expense_categories").insert(payload).execute().data or [None])[0]

    @staticmethod
    def update_category(org_id: str, category_id: str, data: dict) -> Optional[dict]:
        upd = {k: v for k, v in data.items() if v is not None}
        if not upd:
            return None
        res = (
            supabase.table("expense_categories").update(upd)
            .eq("id", category_id).eq("organization_id", org_id).execute()
        )
        return (res.data or [None])[0]

    @staticmethod
    def delete_category(org_id: str, category_id: str) -> bool:
        # A FK é ON DELETE SET NULL: os lançamentos ficam, sem categoria.
        res = (
            supabase.table("expense_categories").delete()
            .eq("id", category_id).eq("organization_id", org_id).execute()
        )
        return bool(res.data)

    # ── Despesas ────────────────────────────────────────────────────────────

    @staticmethod
    def _base_query(org_id: str, select: str = "*"):
        return supabase.table("expenses").select(select).eq("organization_id", org_id)

    @staticmethod
    def list_expenses(
        org_id: Optional[str],
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
        category_id: Optional[str] = None,
        status: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> List[dict]:
        if not org_id:
            return []
        q = ExpenseService._base_query(
            org_id,
            "*, expense_categories(name, kind), stages(name), tournaments(name)",
        )
        if stage_id:
            q = q.eq("stage_id", stage_id)
        if tournament_id:
            q = q.eq("tournament_id", tournament_id)
        if category_id:
            q = q.eq("category_id", category_id)
        if status:
            q = q.eq("status", status)
        if start:
            q = q.gte("created_at", start)
        if end:
            q = q.lte("created_at", _iso_end_of_day(end))

        rows = q.order("created_at", desc=True).execute().data or []
        for r in rows:
            cat = r.pop("expense_categories", None) or {}
            stg = r.pop("stages", None) or {}
            trn = r.pop("tournaments", None) or {}
            r["category_name"] = cat.get("name")
            r["category_kind"] = cat.get("kind")
            r["stage_name"] = stg.get("name")
            r["tournament_name"] = trn.get("name")
        return rows

    @staticmethod
    def create_expense(org_id: str, data: dict, user_id: Optional[str]) -> dict:
        payload = {k: v for k, v in data.items() if v is not None}
        payload["organization_id"] = org_id
        payload["created_by"] = user_id
        # Marcado como pago sem data: assume agora (evita despesa paga "sem data").
        if payload.get("status") == "pago" and not payload.get("paid_at"):
            payload["paid_at"] = datetime.now(timezone.utc).isoformat()
        return (supabase.table("expenses").insert(payload).execute().data or [None])[0]

    @staticmethod
    def update_expense(org_id: str, expense_id: str, data: dict) -> Optional[dict]:
        upd = {k: v for k, v in data.items() if v is not None}
        if not upd:
            return None
        upd["updated_at"] = datetime.now(timezone.utc).isoformat()
        if upd.get("status") == "pago" and not upd.get("paid_at"):
            upd["paid_at"] = datetime.now(timezone.utc).isoformat()
        if upd.get("status") == "pendente":
            upd["paid_at"] = None
        res = (
            supabase.table("expenses").update(upd)
            .eq("id", expense_id).eq("organization_id", org_id).execute()
        )
        return (res.data or [None])[0]

    @staticmethod
    def delete_expense(org_id: str, expense_id: str) -> bool:
        res = (
            supabase.table("expenses").delete()
            .eq("id", expense_id).eq("organization_id", org_id).execute()
        )
        return bool(res.data)

    # ── Agregação para o DRE ────────────────────────────────────────────────

    @staticmethod
    def summarize(
        org_id: Optional[str],
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> dict:
        """Totais por categoria + pago/pendente.

        O DRE usa COMPETÊNCIA: entram lançamentos pagos e pendentes, porque o
        custo já existe mesmo antes de sair do caixa. `paid`/`pending` ficam
        separados para quem quiser a visão de caixa.
        """
        empty = {"total": 0.0, "paid": 0.0, "pending": 0.0, "by_category": []}
        if not org_id:
            return empty

        q = ExpenseService._base_query(
            org_id, "amount, status, category_id, expense_categories(name, kind)"
        )
        if stage_id:
            q = q.eq("stage_id", stage_id)
        if tournament_id:
            q = q.eq("tournament_id", tournament_id)
        if start:
            q = q.gte("created_at", start)
        if end:
            q = q.lte("created_at", _iso_end_of_day(end))

        rows = q.execute().data or []
        if not rows:
            return empty

        total = paid = pending = 0.0
        buckets: dict = {}
        for r in rows:
            amount = float(r.get("amount") or 0)
            total += amount
            if r.get("status") == "pago":
                paid += amount
            else:
                pending += amount

            cat = r.get("expense_categories") or {}
            name = cat.get("name") or "Sem categoria"
            b = buckets.setdefault(name, {"category": name, "kind": cat.get("kind"), "amount": 0.0})
            b["amount"] += amount

        by_category = sorted(buckets.values(), key=lambda x: x["amount"], reverse=True)
        return {"total": total, "paid": paid, "pending": pending, "by_category": by_category}
