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
        # Nasce sempre pendente: se veio marcada como paga, a transição é feita
        # pelo RPC logo abaixo — é ele que debita o caixa. Gravar "pago" direto
        # criaria uma despesa paga que nunca saiu do caixa.
        wants_paid = payload.pop("status", "pendente") == "pago"
        payload["status"] = "pendente"
        payload.pop("paid_at", None)

        created = (supabase.table("expenses").insert(payload).execute().data or [None])[0]
        if created and wants_paid:
            ExpenseService.set_status(org_id, created["id"], "pago")
            cur = supabase.table("expenses").select("*").eq("id", created["id"]).execute()
            created = (cur.data or [created])[0]
        return created

    @staticmethod
    def _friendly(exc: Exception) -> str:
        blob = " ".join(str(getattr(exc, a, "") or "") for a in ("message", "details")) + " " + str(exc)
        if "DESPESA:" in blob:
            frag = blob[blob.find("DESPESA:"):].split("\n")[0]
            for stop in ("  {", " {'", '{"'):
                i = frag.find(stop)
                if i != -1:
                    frag = frag[:i]
            return frag.split(":", 1)[1].strip().strip("'\"").strip()
        return "Não foi possível atualizar a despesa."

    @staticmethod
    def set_status(org_id: str, expense_id: str, status: str) -> dict:
        """Muda o status pelo RPC: o débito/estorno no caixa geral é atômico e
        idempotente (repetir a chamada não movimenta o caixa de novo)."""
        try:
            r = supabase.rpc("expense_set_status", {
                "p_org": org_id, "p_expense": expense_id, "p_status": status,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(ExpenseService._friendly(exc))

    @staticmethod
    def update_expense(org_id: str, expense_id: str, data: dict) -> Optional[dict]:
        upd = {k: v for k, v in data.items() if v is not None}
        # A troca de status vai pelo RPC (mexe no caixa); os demais campos, direto.
        new_status = upd.pop("status", None)
        upd.pop("paid_at", None)  # quem define é o RPC

        if upd:
            upd["updated_at"] = datetime.now(timezone.utc).isoformat()
            res = (
                supabase.table("expenses").update(upd)
                .eq("id", expense_id).eq("organization_id", org_id).execute()
            )
            if not res.data:
                return None

        if new_status:
            ExpenseService.set_status(org_id, expense_id, new_status)

        cur = (
            supabase.table("expenses").select("*")
            .eq("id", expense_id).eq("organization_id", org_id).execute()
        )
        return (cur.data or [None])[0]

    @staticmethod
    def delete_expense(org_id: str, expense_id: str) -> bool:
        # Apagar uma despesa PAGA precisa devolver o dinheiro ao caixa, senão o
        # saldo fica debitado para sempre por um lançamento que não existe mais.
        # Reaproveita a transição já testada em vez de mexer no caixa aqui.
        cur = (
            supabase.table("expenses").select("status")
            .eq("id", expense_id).eq("organization_id", org_id).execute().data or []
        )
        if cur and cur[0].get("status") == "pago":
            try:
                ExpenseService.set_status(org_id, expense_id, "pendente")
            except ValueError:
                pass  # sem caixa configurado: segue com a exclusão

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

        # ── Pagamentos de funcionários ──
        # Já eram custo real (debitam o caixa geral em Funcionários → Pagamentos)
        # mas nunca entravam no DRE. Entram como categoria própria e NÃO editável
        # aqui: quem lança é a tela de Funcionários. Se o operador também criar
        # uma despesa manual "Dealers" para o mesmo pagamento, aí sim duplica —
        # por isso a categoria é nomeada de forma distinta.
        sp_total, sp_paid, sp_pending = ExpenseService._staff_payments(
            org_id, stage_id, tournament_id, start, end
        )
        if sp_total:
            total += sp_total
            paid += sp_paid
            pending += sp_pending
            buckets["Equipe (pagamentos)"] = {
                "category": "Equipe (pagamentos)", "kind": "variavel", "amount": sp_total,
            }

        by_category = sorted(buckets.values(), key=lambda x: x["amount"], reverse=True)
        return {"total": total, "paid": paid, "pending": pending, "by_category": by_category}

    @staticmethod
    def _staff_payments(
        org_id: str,
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ):
        """(total, pago, pendente) dos pagamentos de equipe no recorte.

        `staff_payments` é por ETAPA — não tem torneio. Filtrando por torneio,
        devolvemos zero para não atribuir a um torneio um custo da etapa toda.
        """
        if tournament_id:
            return 0.0, 0.0, 0.0
        try:
            q = supabase.table("staff_payments").select("amount, status") \
                .eq("organization_id", org_id)
            if stage_id:
                q = q.eq("stage_id", stage_id)
            if start:
                q = q.gte("created_at", start)
            if end:
                q = q.lte("created_at", _iso_end_of_day(end))
            rows = q.execute().data or []
        except Exception:
            return 0.0, 0.0, 0.0

        total = paid = pending = 0.0
        for r in rows:
            v = float(r.get("amount") or 0)
            total += v
            # A tela de Funcionários grava 'paid'; qualquer outro estado é a pagar.
            if r.get("status") == "paid":
                paid += v
            else:
                pending += v
        return total, paid, pending

    # ── Outras receitas ─────────────────────────────────────────────────────
    # Bar, patrocínio, aluguel de espaço: faturamento que não passa pelo caixa
    # de torneio e ficava fora do DRE. Mesma mecânica das despesas, com o sinal
    # invertido no caixa (receber CREDITA).

    @staticmethod
    def list_revenues(
        org_id: Optional[str],
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
        status: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> List[dict]:
        if not org_id:
            return []
        q = (
            supabase.table("other_revenues")
            .select("*, stages(name), tournaments(name)")
            .eq("organization_id", org_id)
        )
        if stage_id:
            q = q.eq("stage_id", stage_id)
        if tournament_id:
            q = q.eq("tournament_id", tournament_id)
        if status:
            q = q.eq("status", status)
        if start:
            q = q.gte("created_at", start)
        if end:
            q = q.lte("created_at", _iso_end_of_day(end))

        rows = q.order("created_at", desc=True).execute().data or []
        for r in rows:
            stg = r.pop("stages", None) or {}
            trn = r.pop("tournaments", None) or {}
            r["stage_name"] = stg.get("name")
            r["tournament_name"] = trn.get("name")
        return rows

    @staticmethod
    def set_revenue_status(org_id: str, revenue_id: str, status: str) -> dict:
        try:
            r = supabase.rpc("revenue_set_status", {
                "p_org": org_id, "p_revenue": revenue_id, "p_status": status,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(ExpenseService._friendly_revenue(exc))

    @staticmethod
    def _friendly_revenue(exc: Exception) -> str:
        blob = " ".join(str(getattr(exc, a, "") or "") for a in ("message", "details")) + " " + str(exc)
        if "RECEITA:" in blob:
            frag = blob[blob.find("RECEITA:"):].split("\n")[0]
            for stop in ("  {", " {'", '{"'):
                i = frag.find(stop)
                if i != -1:
                    frag = frag[:i]
            return frag.split(":", 1)[1].strip().strip("'\"").strip()
        return "Não foi possível atualizar a receita."

    @staticmethod
    def create_revenue(org_id: str, data: dict, user_id: Optional[str]) -> dict:
        payload = {k: v for k, v in data.items() if v is not None}
        payload["organization_id"] = org_id
        payload["created_by"] = user_id
        # Nasce pendente; se veio recebida, a transição pelo RPC credita o caixa.
        wants_received = payload.pop("status", "pendente") == "recebido"
        payload["status"] = "pendente"
        payload.pop("received_at", None)

        created = (supabase.table("other_revenues").insert(payload).execute().data or [None])[0]
        if created and wants_received:
            ExpenseService.set_revenue_status(org_id, created["id"], "recebido")
            cur = supabase.table("other_revenues").select("*").eq("id", created["id"]).execute()
            created = (cur.data or [created])[0]
        return created

    @staticmethod
    def update_revenue(org_id: str, revenue_id: str, data: dict) -> Optional[dict]:
        upd = {k: v for k, v in data.items() if v is not None}
        new_status = upd.pop("status", None)
        upd.pop("received_at", None)

        if upd:
            upd["updated_at"] = datetime.now(timezone.utc).isoformat()
            res = (
                supabase.table("other_revenues").update(upd)
                .eq("id", revenue_id).eq("organization_id", org_id).execute()
            )
            if not res.data:
                return None

        if new_status:
            ExpenseService.set_revenue_status(org_id, revenue_id, new_status)

        cur = (
            supabase.table("other_revenues").select("*")
            .eq("id", revenue_id).eq("organization_id", org_id).execute()
        )
        return (cur.data or [None])[0]

    @staticmethod
    def delete_revenue(org_id: str, revenue_id: str) -> bool:
        # Apagar receita recebida devolve o crédito, senão o caixa fica inflado.
        cur = (
            supabase.table("other_revenues").select("status")
            .eq("id", revenue_id).eq("organization_id", org_id).execute().data or []
        )
        if cur and cur[0].get("status") == "recebido":
            try:
                ExpenseService.set_revenue_status(org_id, revenue_id, "pendente")
            except ValueError:
                pass
        res = (
            supabase.table("other_revenues").delete()
            .eq("id", revenue_id).eq("organization_id", org_id).execute()
        )
        return bool(res.data)

    @staticmethod
    def summarize_revenues(
        org_id: Optional[str],
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> dict:
        """Total por origem + recebido/pendente (competência, como as despesas)."""
        empty = {"total": 0.0, "received": 0.0, "pending": 0.0, "by_source": []}
        if not org_id:
            return empty
        q = (
            supabase.table("other_revenues").select("amount, status, source")
            .eq("organization_id", org_id)
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

        total = received = pending = 0.0
        buckets: dict = {}
        for r in rows:
            v = float(r.get("amount") or 0)
            total += v
            if r.get("status") == "recebido":
                received += v
            else:
                pending += v
            name = r.get("source") or "Outros"
            b = buckets.setdefault(name, {"category": name, "kind": "receita", "amount": 0.0})
            b["amount"] += v

        by_source = sorted(buckets.values(), key=lambda x: x["amount"], reverse=True)
        return {"total": total, "received": received, "pending": pending, "by_source": by_source}

    @staticmethod
    def guarantee_committed(
        org_id: Optional[str],
        stage_id: Optional[str] = None,
        tournament_id: Optional[str] = None,
    ) -> float:
        """Soma da premiação garantida pela casa no recorte — INFORMATIVA.

        NÃO entra no total de despesas: esse dinheiro sai como prêmio e o DRE já
        o subtrai em `gross_revenue − prizes`. Somar de novo contaria duas vezes.
        """
        if not org_id:
            return 0.0
        try:
            q = supabase.table("tournaments").select("guaranteed_prize") \
                .eq("organization_id", org_id).gt("guaranteed_prize", 0)
            if stage_id:
                q = q.eq("stage_id", stage_id)
            if tournament_id:
                q = q.eq("id", tournament_id)
            rows = q.execute().data or []
        except Exception:
            return 0.0
        return sum(float(r.get("guaranteed_prize") or 0) for r in rows)
