from datetime import datetime, timezone
from typing import Optional
from app.database import supabase

# Programa de fidelidade — Fase 1 (núcleo).
# Escopamos EXPLICITAMENTE pela org do JWT (não dependemos só do RLS): o backend
# local roda com service_role e queries sem filtro pegariam a org errada.
# Habilitado apenas para planos PRO/PREMIUM — mesmo gate da trigger de ganho.

PRO_PLANS = ("pro", "premium")


class LoyaltyService:

    @staticmethod
    def _org_plan(org_id: str) -> Optional[str]:
        # RPC SECURITY DEFINER (bypassa RLS/modo do cliente) — leitura confiável.
        try:
            r = supabase.rpc("org_plan_code", {"p_org": org_id}).execute()
            return r.data if isinstance(r.data, str) else (r.data or None)
        except Exception:
            res = supabase.table("organizations").select("plan_code").eq("id", org_id).execute().data or []
            return res[0].get("plan_code") if res else None

    @staticmethod
    def _has_loyalty(org_id: str) -> bool:
        try:
            r = supabase.rpc("org_has_loyalty", {"p_org": org_id}).execute()
            return bool(r.data)
        except Exception:
            return False

    @staticmethod
    def get_config(org_id: Optional[str]) -> dict:
        if not org_id:
            return {"enabled": False, "plan_code": None, "available": False, "settings": None, "tiers": []}
        settings = supabase.table("loyalty_settings").select("*").eq("organization_id", org_id).execute().data or []
        s = settings[0] if settings else None
        plan = LoyaltyService._org_plan(org_id)
        enabled = LoyaltyService._has_loyalty(org_id)
        tiers = (
            supabase.table("loyalty_tiers").select("*")
            .eq("organization_id", org_id).order("sort_order").execute().data or []
        )
        return {
            "enabled": enabled,
            "plan_code": plan,
            "available": plan in PRO_PLANS,   # entitlement do plano (independe do toggle)
            "settings": s,
            "tiers": tiers,
        }

    @staticmethod
    def update_settings(org_id: Optional[str], data: dict) -> Optional[dict]:
        if not org_id:
            return None
        upd = {k: v for k, v in data.items() if v is not None}
        if not upd:
            return None
        upd["updated_at"] = datetime.now(timezone.utc).isoformat()
        res = (
            supabase.table("loyalty_settings").update(upd)
            .eq("organization_id", org_id).execute()
        )
        return (res.data or [None])[0]

    @staticmethod
    def get_player_loyalty(org_id: Optional[str], player_id: str) -> dict:
        acct_q = (
            supabase.table("loyalty_accounts")
            .select("*, loyalty_tiers(id, name, color, min_points, points_multiplier)")
            .eq("player_id", player_id)
        )
        if org_id:
            acct_q = acct_q.eq("organization_id", org_id)
        acct = acct_q.execute().data or []
        account = acct[0] if acct else None
        tier = account.pop("loyalty_tiers", None) if account else None

        ledger_q = (
            supabase.table("loyalty_ledger")
            .select("id, delta, balance_after, reason, description, created_at, transaction_id")
            .eq("player_id", player_id)
        )
        if org_id:
            ledger_q = ledger_q.eq("organization_id", org_id)
        ledger = ledger_q.order("created_at", desc=True).limit(25).execute().data or []

        tiers = []
        if org_id:
            tiers = (
                supabase.table("loyalty_tiers").select("*")
                .eq("organization_id", org_id).order("min_points").execute().data or []
            )

        lifetime = float((account or {}).get("lifetime_points") or 0)
        next_tier = None
        for tr in tiers:
            if float(tr.get("min_points") or 0) > lifetime:
                next_tier = tr
                break

        rewards = []
        if org_id:
            rewards = (
                supabase.table("loyalty_rewards").select("*")
                .eq("organization_id", org_id).eq("active", True)
                .order("sort_order").order("cost_points").execute().data or []
            )

        return {
            "account": account,
            "tier": tier,
            "next_tier": next_tier,
            "lifetime_points": lifetime,
            "cashback_balance": float((account or {}).get("cashback_balance") or 0),
            "ledger": ledger,
            "rewards": rewards,
            "goals": LoyaltyService.get_goals(org_id, player_id),
            "giftable_credits": LoyaltyService.giftable_credits(org_id, player_id),
        }

    # ── Recompensas (catálogo) ──────────────────────────────────────────────
    @staticmethod
    def get_rewards(org_id: Optional[str], active_only: bool = False) -> list:
        if not org_id:
            return []
        q = supabase.table("loyalty_rewards").select("*").eq("organization_id", org_id)
        if active_only:
            q = q.eq("active", True)
        return q.order("sort_order").order("cost_points").execute().data or []

    @staticmethod
    def create_reward(org_id: str, data: dict) -> dict:
        payload = {**data, "organization_id": org_id}
        return (supabase.table("loyalty_rewards").insert(payload).execute().data or [None])[0]

    @staticmethod
    def update_reward(org_id: str, reward_id: str, data: dict) -> Optional[dict]:
        upd = {k: v for k, v in data.items() if v is not None}
        if not upd:
            return None
        res = (
            supabase.table("loyalty_rewards").update(upd)
            .eq("id", reward_id).eq("organization_id", org_id).execute()
        )
        return (res.data or [None])[0]

    @staticmethod
    def delete_reward(org_id: str, reward_id: str) -> bool:
        res = (
            supabase.table("loyalty_rewards").delete()
            .eq("id", reward_id).eq("organization_id", org_id).execute()
        )
        return bool(res.data)

    # ── Resgate / conversão (RPCs atômicos) ─────────────────────────────────
    @staticmethod
    def _friendly(exc: Exception) -> str:
        blob = " ".join(str(getattr(exc, a, "") or "") for a in ("message", "details")) + " " + str(exc)
        if "FIDELIDADE:" in blob:
            frag = blob[blob.find("FIDELIDADE:"):].split("\n")[0]
            for stop in ("  {", " {'", '{"'):
                i = frag.find(stop)
                if i != -1:
                    frag = frag[:i]
            return frag.split(":", 1)[1].strip().strip("'\"").strip()
        return "Falha ao processar a operação de fidelidade."

    @staticmethod
    def redeem_reward(org_id: str, player_id: str, reward_id: str) -> dict:
        try:
            r = supabase.rpc("loyalty_redeem_reward", {
                "p_org": org_id, "p_player": player_id, "p_reward": reward_id,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(LoyaltyService._friendly(exc))

    @staticmethod
    def convert_cashback(org_id: str, player_id: str) -> dict:
        try:
            r = supabase.rpc("loyalty_convert_cashback", {
                "p_org": org_id, "p_player": player_id,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(LoyaltyService._friendly(exc))

    # ── Cupons ──────────────────────────────────────────────────────────────
    @staticmethod
    def redeem_coupon(org_id: str, player_id: str, code: str) -> dict:
        try:
            r = supabase.rpc("loyalty_redeem_coupon", {
                "p_org": org_id, "p_player": player_id, "p_code": code,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(LoyaltyService._friendly(exc))

    @staticmethod
    def get_coupons(org_id: Optional[str]) -> list:
        if not org_id:
            return []
        return (
            supabase.table("loyalty_coupons").select("*")
            .eq("organization_id", org_id).order("created_at", desc=True).execute().data or []
        )

    @staticmethod
    def create_coupon(org_id: str, data: dict) -> dict:
        payload = {**data, "code": str(data.get("code", "")).upper().strip(), "organization_id": org_id}
        return (supabase.table("loyalty_coupons").insert(payload).execute().data or [None])[0]

    @staticmethod
    def delete_coupon(org_id: str, coupon_id: str) -> bool:
        res = supabase.table("loyalty_coupons").delete().eq("id", coupon_id).eq("organization_id", org_id).execute()
        return bool(res.data)

    # ── Metas / desafios ────────────────────────────────────────────────────
    @staticmethod
    def get_goals(org_id: Optional[str], player_id: Optional[str]) -> list:
        if not org_id:
            return []
        goals = (
            supabase.table("loyalty_goals").select("*")
            .eq("organization_id", org_id).eq("active", True).order("sort_order").execute().data or []
        )
        claimed = set()
        if player_id:
            rows = (
                supabase.table("loyalty_goal_claims").select("goal_id, period_key")
                .eq("organization_id", org_id).eq("player_id", player_id).execute().data or []
            )
            claimed = {(c["goal_id"], c["period_key"]) for c in rows}
        ym = datetime.now(timezone.utc).strftime("%Y-%m")
        out = []
        for g in goals:
            progress = 0.0
            if player_id:
                try:
                    pr = supabase.rpc("loyalty_goal_current", {
                        "p_org": org_id, "p_player": player_id, "p_goal": g["id"],
                    }).execute()
                    progress = float(pr.data or 0)
                except Exception:
                    progress = 0.0
            key = ym if g.get("period") == "monthly" else "all"
            g["progress"] = progress
            g["completed"] = progress >= float(g.get("target") or 0)
            g["claimed"] = (g["id"], key) in claimed
            out.append(g)
        return out

    @staticmethod
    def claim_goal(org_id: str, player_id: str, goal_id: str) -> dict:
        try:
            r = supabase.rpc("loyalty_claim_goal", {
                "p_org": org_id, "p_player": player_id, "p_goal": goal_id,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(LoyaltyService._friendly(exc))

    @staticmethod
    def create_goal(org_id: str, data: dict) -> dict:
        return (supabase.table("loyalty_goals").insert({**data, "organization_id": org_id}).execute().data or [None])[0]

    @staticmethod
    def delete_goal(org_id: str, goal_id: str) -> bool:
        res = supabase.table("loyalty_goals").delete().eq("id", goal_id).eq("organization_id", org_id).execute()
        return bool(res.data)

    # ── Aniversário / presente (Fase 4) ─────────────────────────────────────
    @staticmethod
    def giftable_credits(org_id: Optional[str], player_id: str) -> list:
        """Créditos ativos e ainda não usados — presenteáveis a outro jogador."""
        if not org_id:
            return []
        rows = (
            supabase.table("loyalty_settings").select("system_sponsor_id")
            .eq("organization_id", org_id).execute().data or []
        )
        sponsor = rows[0].get("system_sponsor_id") if rows else None
        q = (
            supabase.table("player_credits").select("id, original_amount, remaining_amount, notes, sponsor_id")
            .eq("player_id", player_id).eq("status", "active").eq("used_amount", 0)
        )
        if org_id:
            q = q.eq("organization_id", org_id)
        creds = q.execute().data or []
        # Só os créditos do programa de fidelidade (sponsor de sistema).
        return [c for c in creds if (not sponsor or c.get("sponsor_id") == sponsor)]

    @staticmethod
    def gift_credit(org_id: str, credit_id: str, to_player_id: str) -> dict:
        try:
            r = supabase.rpc("loyalty_gift_credit", {
                "p_org": org_id, "p_credit": credit_id, "p_to": to_player_id,
            }).execute()
            return r.data or {}
        except Exception as exc:
            raise ValueError(LoyaltyService._friendly(exc))
