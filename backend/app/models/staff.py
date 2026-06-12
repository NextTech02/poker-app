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
    name: str
    email: str
    password: str
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
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class MyPermissions(BaseModel):
    is_admin: bool = False
    permissions: List[str] = []
    group_name: Optional[str] = None
