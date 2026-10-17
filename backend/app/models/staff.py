from pydantic import BaseModel, EmailStr
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
    #
    # EmailStr (e não str): o e-mail digitado errado só era recusado lá no
    # Supabase, depois de uma ida à rede, e voltava como um 400 genérico. Aqui
    # a recusa é imediata e aponta o campo — mesmo tratamento do convite do
    # dono do clube em OrganizationCreate.
    email: EmailStr
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
    # Só no retorno do convite. None = nenhum e-mail era esperado (a conta já
    # existia). False + `invite_error` (sem_chave | recusado | indisponivel |
    # sem_link): o vínculo foi criado, mas o e-mail não saiu — a tela avisa e
    # o admin usa "Reenviar convite".
    invite_sent: Optional[bool] = None
    invite_error: Optional[str] = None
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
    # Módulos contratados pelo clube (tournament/cash). Entitlement
    # comercial, não isolamento de dados — viaja aqui porque a tela já
    # chama este endpoint uma vez e não vale um request extra nem um
    # claim novo no JWT (ver app/services/module_service.py).
    modules: List[str] = ["tournament"]
    # Nome do clube, para o cabeçalho do menu. Opcional: um backend que não
    # mande o campo deixa o cabeçalho sem a linha, e nada mais muda.
    organization_name: Optional[str] = None
    # Nome do funcionário logado: sai no bilhete ("Cajero").
    staff_name: Optional[str] = None
