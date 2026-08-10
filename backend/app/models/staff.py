from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


# ── Permission Groups ──

class PermissionGroupCreate(BaseModel):
    name: str
    description: Optional[str] = None
    permissions: List[str] = []


class PermissionGroupUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[List[str]] = None


class PermissionGroupResponse(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    permissions: List[str] = []
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ── Staff ──

class StaffCreate(BaseModel):
    # Só o e-mail é obrigatório: o funcionário recebe o convite e define nome e
    # senha. `name` fica opcional para quem quiser deixar a lista já legível
    # antes do aceite; `password` some — o admin não define senha de ninguém.
    email: str
    name: Optional[str] = None
    permission_group_id: Optional[str] = None


class StaffUpdate(BaseModel):
    name: Optional[str] = None
    permission_group_id: Optional[str] = None
    active: Optional[bool] = None


class StaffResponse(BaseModel):
    id: str
    auth_user_id: str
    name: str
    email: str
    permission_group_id: Optional[str] = None
    permission_group_name: Optional[str] = None
    permissions: List[str] = []
    active: bool = True
    # 'pending' enquanto um convidado que já tinha conta não respondeu.
    invite_status: str = "accepted"
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class MyPermissions(BaseModel):
    is_admin: bool = False
    permissions: List[str] = []
    group_name: Optional[str] = None
    # Platform admin (NextHub): atravessa organizações para dar suporte e é
    # quem enxerga a tela de cadastro de clientes. Vem do claim do JWT, não do
    # banco — quem decide é o Auth Hook.
    is_platform_admin: bool = False
