from fastapi import APIRouter, Depends
from typing import List, Optional, Dict, Any
from pydantic import BaseModel

from app.services.sync_service import SyncService
from app.auth.jwt import get_current_user

router = APIRouter(prefix="/sync", tags=["sync"])


class SyncOp(BaseModel):
    clientMutationId: Optional[str] = None
    kind: str
    method: Optional[str] = None
    url: Optional[str] = None
    body: Optional[Dict[str, Any]] = None
    params: Optional[Dict[str, Any]] = None
    clientEntityIds: Optional[Dict[str, Any]] = None
    deps: Optional[List[str]] = None


class SyncBatchRequest(BaseModel):
    ops: List[SyncOp] = []


@router.post("/batch")
def sync_batch(payload: SyncBatchRequest, current_user: dict = Depends(get_current_user)):
    """Reexecuta a fila de mutações offline, em ordem e de forma idempotente.
    Devolve o status de cada op (applied / conflict / error)."""
    user_id = current_user.get("sub")
    # A organização vem do CLAIM do JWT. O ledger é gravado com o client admin
    # (sync_mutations é deny-all), que não carrega o claim — então o org precisa
    # ser passado explicitamente, senão o INSERT viola o NOT NULL.
    org_id = current_user.get("organization_id")
    ops = [op.model_dump() for op in payload.ops]
    results = SyncService.apply_batch(ops, user_id, org_id)
    return {"results": results}
