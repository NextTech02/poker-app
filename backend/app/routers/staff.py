from fastapi import APIRouter, HTTPException, Depends
from typing import List
from app.models.staff import (
    PermissionGroupCreate,
    PermissionGroupUpdate,
    PermissionGroupResponse,
    StaffCreate,
    StaffUpdate,
    StaffResponse,
    MyPermissions,
)
from app.services.staff_service import StaffService
from app.auth.jwt import get_current_user
from app.auth.permissions import require_permission

router = APIRouter(prefix="/staff", tags=["staff"])

# Managing staff and permission groups is itself a privileged action: without
# this gate any authenticated user could create a group with all permissions and
# attach themselves to it, self-escalating to super-admin. Mutations require the
# 'employees' permission (super-admins bypass via require_permission).
_manage_staff = Depends(require_permission("employees"))


# ── My Permissions ──

@router.get("/me/permissions", response_model=MyPermissions)
def get_my_permissions(user=Depends(get_current_user)):
    return StaffService.get_my_permissions(user.get("sub"))


# ── Permission Groups ──

@router.post("/groups", response_model=PermissionGroupResponse)
def create_group(data: PermissionGroupCreate, user=_manage_staff):
    try:
        return StaffService.create_group(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/groups", response_model=List[PermissionGroupResponse])
def get_groups(user=Depends(get_current_user)):
    return StaffService.get_groups()


@router.get("/groups/{group_id}", response_model=PermissionGroupResponse)
def get_group(group_id: str, user=Depends(get_current_user)):
    group = StaffService.get_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Grupo não encontrado")
    return group


@router.patch("/groups/{group_id}", response_model=PermissionGroupResponse)
def update_group(group_id: str, data: PermissionGroupUpdate, user=_manage_staff):
    try:
        result = StaffService.update_group(group_id, data)
        if not result:
            raise HTTPException(status_code=404, detail="Grupo não encontrado")
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/groups/{group_id}")
def delete_group(group_id: str, user=_manage_staff):
    if not StaffService.delete_group(group_id):
        raise HTTPException(status_code=404, detail="Grupo não encontrado")
    return {"message": "Grupo removido"}


# ── Staff ──

@router.post("", response_model=StaffResponse)
def create_staff(data: StaffCreate, user=_manage_staff):
    try:
        return StaffService.create_staff(data, user.get("sub"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[StaffResponse])
def get_staff_list(user=Depends(get_current_user)):
    return StaffService.get_staff_list()


@router.get("/{staff_id}", response_model=StaffResponse)
def get_staff(staff_id: str, user=Depends(get_current_user)):
    staff = StaffService.get_staff(staff_id)
    if not staff:
        raise HTTPException(status_code=404, detail="Funcionário não encontrado")
    return staff


@router.patch("/{staff_id}", response_model=StaffResponse)
def update_staff(staff_id: str, data: StaffUpdate, user=_manage_staff):
    try:
        result = StaffService.update_staff(staff_id, data)
        if not result:
            raise HTTPException(status_code=404, detail="Funcionário não encontrado")
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{staff_id}")
def delete_staff(staff_id: str, user=_manage_staff):
    try:
        ok = StaffService.delete_staff(staff_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not ok:
        raise HTTPException(status_code=404, detail="Funcionário não encontrado")
    return {"message": "Funcionário desativado"}
