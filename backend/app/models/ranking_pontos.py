"""Corpos das rotas do ranking de pontos (Manual de Ranking NSOP)."""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class RankingRulesUpdate(BaseModel):
    pontos_base: Optional[float] = Field(None, gt=0, le=10000)
    jogadores_referencia: Optional[float] = Field(None, gt=0)
    jogadores_expoente: Optional[float] = Field(None, ge=0, le=2)
    jogadores_fator_minimo: Optional[float] = Field(None, gt=0, le=10)
    jogadores_fator_maximo: Optional[float] = Field(None, gt=0, le=10)
    buy_in_referencia: Optional[float] = Field(None, gt=0)
    buy_in_expoente: Optional[float] = Field(None, ge=0, le=2)
    buy_in_fator_minimo: Optional[float] = Field(None, gt=0, le=10)
    buy_in_fator_maximo: Optional[float] = Field(None, gt=0, le=10)
    minimo_de_jogadores: Optional[int] = Field(None, ge=1, le=10000)


class RankingTournamentUpdate(BaseModel):
    scoring: Optional[bool] = None
    # Mandar `buy_in: null` volta ao padrão (o meio de entrada principal).
    buy_in: Optional[float] = Field(None, gt=0)


class RankingPosition(BaseModel):
    position: int = Field(..., ge=1)
    player_id: Optional[str] = None


class RankingOfficialRequest(BaseModel):
    positions: List[RankingPosition] = Field(default_factory=list)


class RankingReopenRequest(BaseModel):
    reason: str = Field(..., max_length=500)


class RankingSeasonCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    best_results: Optional[int] = Field(8, ge=1, le=100)
    stage_ids: List[str] = Field(default_factory=list)


class RankingSeasonUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    # `null` = somar todos os resultados.
    best_results: Optional[int] = Field(None, ge=1, le=100)
    status: Optional[Literal["active", "closed"]] = None
    stage_ids: Optional[List[str]] = None
