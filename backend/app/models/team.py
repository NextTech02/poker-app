"""Torneio por equipes — corpos da API (as respostas são dicionários montados
pelo `team_service`)."""
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class TeamCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    captain_player_id: str
    # Na ordem do revezamento da final (pode ser trocada depois).
    player_ids: List[str] = Field(..., min_length=1, max_length=4)


class TeamUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    captain_player_id: Optional[str] = None
    player_ids: Optional[List[str]] = Field(None, min_length=1, max_length=4)


class RelayOrderUpdate(BaseModel):
    player_ids: List[str] = Field(..., min_length=1, max_length=4)
    force: bool = False


class SeatingRequest(BaseModel):
    day_id: Optional[str] = None
    redo: bool = False


class ResultCorrection(BaseModel):
    """Correção de UMA eliminação da Fase 1."""
    tie_with_previous: Optional[bool] = None
    table_id: Optional[str] = None
    swap_with_previous: bool = False


class TablePositions(BaseModel):
    """Posições digitadas pela direção para uma mesa terminada ({inscrição: posição})."""
    positions: Dict[str, int]


class VerifyRequest(BaseModel):
    verified: bool = True


class TiebreakOrder(BaseModel):
    team_ids: List[str] = Field(..., min_length=1)


class OfficialRequest(BaseModel):
    force: bool = False


class FinalSetup(BaseModel):
    finalists: int = Field(..., ge=1, le=8)
    chips: Optional[int] = Field(None, gt=0)


class TeamCharge(BaseModel):
    buy_type_id: str
    payment_method: Optional[str] = Field("cash", max_length=50)
    client_mutation_id: Optional[str] = Field(None, max_length=100)


class TeamChargeCancel(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)
