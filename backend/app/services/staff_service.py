from typing import List, Optional
from datetime import datetime, timezone
from app.database import supabase
from app.config import get_settings
from app.models.staff import (
    PermissionGroupCreate,
    PermissionGroupUpdate,
    PermissionGroupResponse,
    StaffCreate,
    StaffUpdate,
    StaffResponse,
    MyPermissions,
)

ALL_PERMISSIONS = [
    'dashboard', 'stages', 'tournaments', 'players',
    'cashier', 'cashier_players', 'cashier_tickets', 'prizes',
    'prizes_release', 'financial', 'reports', 'general_cash', 'rankings',
    'blinds', 'tables', 'broadcast', 'employees',
    'cashbox.operate', 'cashbox.admin',
    'sangi',
]

# Permissions that imply the staff member can have their own cashbox
CASHBOX_OPERATING_PERMISSIONS = ('cashbox.operate', 'cashbox.admin', 'cashier', 'cashier_players')


def _has_cashbox_permission(permissions: list) -> bool:
    return any(p in (permissions or []) for p in CASHBOX_OPERATING_PERMISSIONS)

settings = get_settings()


class StaffService:

    # ================================================
    # Permission Groups
    # ================================================

    @staticmethod
    def create_group(data: PermissionGroupCreate) -> PermissionGroupResponse:
        insert_data = {
            "name": data.name,
            "description": data.description,
            "permissions": data.permissions,
        }
        response = supabase.table("permission_groups").insert(insert_data).execute()
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def get_groups() -> List[PermissionGroupResponse]:
        response = supabase.table("permission_groups").select("*") \
            .order("name").execute()
        return [PermissionGroupResponse(**g) for g in (response.data or [])]

    @staticmethod
    def get_group(group_id: str) -> Optional[PermissionGroupResponse]:
        response = supabase.table("permission_groups").select("*") \
            .eq("id", group_id).execute()
        if not response.data:
            return None
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def update_group(group_id: str, data: PermissionGroupUpdate) -> Optional[PermissionGroupResponse]:
        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            raise ValueError("Nenhum campo para atualizar")
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        response = supabase.table("permission_groups").update(update_data) \
            .eq("id", group_id).execute()
        if not response.data:
            return None
        return PermissionGroupResponse(**response.data[0])

    @staticmethod
    def delete_group(group_id: str) -> bool:
        response = supabase.table("permission_groups").delete() \
            .eq("id", group_id).execute()
        return len(response.data) > 0

    # ================================================
    # Staff
    # ================================================

    @staticmethod
    def create_staff(data: StaffCreate, created_by: str) -> StaffResponse:
        """Create a staff member: creates Supabase Auth user + staff record"""
        import httpx

        # Create user in Supabase Auth via admin API
        auth_url = f"{settings.supabase_url}/auth/v1/admin/users"
        headers = {
            "apikey": settings.supabase_service_key,
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        }
        body = {
            "email": data.email,
            "password": data.password,
            "email_confirm": True,
        }

        resp = httpx.post(auth_url, json=body, headers=headers, timeout=15)
        if resp.status_code >= 400:
            error_detail = resp.json().get("msg") or resp.json().get("message") or resp.text
            raise ValueError(f"Erro ao criar usuario: {error_detail}")

        auth_user = resp.json()
        auth_user_id = auth_user["id"]

        # Create staff record
        insert_data = {
            "auth_user_id": auth_user_id,
            "name": data.name,
            "email": data.email,
            "permission_group_id": data.permission_group_id,
            "active": True,
            "created_by": created_by,
        }

        response = supabase.table("staff").insert(insert_data).execute()
        staff = response.data[0]

        # Get group info
        group_name = None
        permissions = []
        if staff.get("permission_group_id"):
            group = StaffService.get_group(staff["permission_group_id"])
            if group:
                group_name = group.name
                permissions = group.permissions

        # Auto-create cashboxes in every active stage if this staff has the permission
        if _has_cashbox_permission(permissions):
            from app.services.cashbox_service import CashboxService
            try:
                CashboxService.auto_create_for_staff(staff["id"])
            except Exception:
                pass  # auto-create is best-effort; failures shouldn't block staff creation

        return StaffResponse(
            **staff,
            permission_group_name=group_name,
            permissions=permissions,
        )

    @staticmethod
    def get_staff_list() -> List[StaffResponse]:
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).order("name").execute()

        results = []
        for item in (response.data or []):
            group = item.pop("permission_groups", {}) or {}
            results.append(StaffResponse(
                **item,
                permission_group_name=group.get("name"),
                permissions=group.get("permissions", []),
            ))
        return results

    @staticmethod
    def get_staff(staff_id: str) -> Optional[StaffResponse]:
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).eq("id", staff_id).execute()

        if not response.data:
            return None
        item = response.data[0]
        group = item.pop("permission_groups", {}) or {}
        return StaffResponse(
            **item,
            permission_group_name=group.get("name"),
            permissions=group.get("permissions", []),
        )

    @staticmethod
    def update_staff(staff_id: str, data: StaffUpdate) -> Optional[StaffResponse]:
        update_data = data.model_dump(exclude_unset=True)
        if not update_data:
            raise ValueError("Nenhum campo para atualizar")
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Block deactivation if there is an open cashbox with a non-zero balance
        if update_data.get("active") is False:
            StaffService._guard_no_open_cashbox(staff_id)

        response = supabase.table("staff").update(update_data) \
            .eq("id", staff_id).execute()
        if not response.data:
            return None

        # If permission group changed and the new group grants cashbox access,
        # ensure cashboxes exist in every active stage.
        if "permission_group_id" in update_data:
            updated = StaffService.get_staff(staff_id)
            if updated and _has_cashbox_permission(updated.permissions):
                from app.services.cashbox_service import CashboxService
                try:
                    CashboxService.auto_create_for_staff(staff_id)
                except Exception:
                    pass

        return StaffService.get_staff(staff_id)

    @staticmethod
    def _guard_no_open_cashbox(staff_id: str) -> None:
        """Raise ValueError if this staff has any open cashbox."""
        open_cb = supabase.table("cashboxes").select("id, current_balance, stage_id") \
            .eq("staff_id", staff_id).eq("status", "open").execute()
        if open_cb.data:
            row = open_cb.data[0]
            balance = float(row.get("current_balance") or 0)
            raise ValueError(
                f"Funcionário tem caixa aberto com saldo de R$ {balance:.2f}. "
                f"Feche o caixa antes de desativar."
            )

    @staticmethod
    def delete_staff(staff_id: str) -> bool:
        """Deactivate staff (doesn't delete auth user). Blocks if any cashbox is open."""
        StaffService._guard_no_open_cashbox(staff_id)
        response = supabase.table("staff").update({
            "active": False,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", staff_id).execute()
        return len(response.data) > 0

    # ================================================
    # My Permissions
    # ================================================

    @staticmethod
    def get_my_permissions(auth_user_id: str) -> MyPermissions:
        """Get permissions for the currently logged-in user"""
        response = supabase.table("staff").select(
            "*, permission_groups(name, permissions)"
        ).eq("auth_user_id", auth_user_id).execute()

        # No staff record: historically treated as super-admin ("original user").
        # That made ANY authenticated user without a staff row a super-admin — a
        # privilege-escalation default. We now pin admin to an explicit allowlist
        # of owner IDs (SUPER_ADMIN_USER_IDS). If the allowlist is empty (not yet
        # configured) we fall back to the old behavior with a warning so a deploy
        # that forgets the env var doesn't lock everyone out.
        if not response.data:
            from app.config import get_settings
            allow = get_settings().super_admin_ids
            if auth_user_id in allow:
                return MyPermissions(is_admin=True, permissions=ALL_PERMISSIONS, group_name="Admin")
            # FAIL-CLOSED: autenticado mas sem vínculo (sem staff e fora da
            # allowlist) => nenhum acesso. Antes, se a allowlist estivesse VAZIA
            # qualquer conta sem staff virava super-admin — um deploy que
            # esquecesse a env dava poder total a qualquer usuário. Num SaaS isso
            # seria fatal: o funcionário de um cliente viraria dono de tudo.
            return MyPermissions(is_admin=False, permissions=[], group_name=None)

        staff = response.data[0]

        if not staff.get("active"):
            return MyPermissions(is_admin=False, permissions=[], group_name=None)

        group = staff.get("permission_groups", {}) or {}
        permissions = group.get("permissions", [])
        group_name = group.get("name")

        return MyPermissions(
            is_admin=False,
            permissions=permissions,
            group_name=group_name,
        )
