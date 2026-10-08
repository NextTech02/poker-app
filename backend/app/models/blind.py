from pydantic import BaseModel, Field, model_validator
from typing import Optional
from datetime import datetime
from uuid import UUID


class BlindBase(BaseModel):
    level: int = Field(..., gt=0, description="Blind level number (must be positive)")
    small_blind: int = Field(default=0, ge=0, description="Small blind amount (0 or positive)")
    big_blind: int = Field(default=0, ge=0, description="Big blind amount (0 or positive)")
    ante: int = Field(default=0, ge=0, description="Ante amount (0 or positive)")
    duration: int = Field(default=15, gt=0, description="Duration in minutes (must be positive)")
    is_break: bool = Field(default=False, description="True if this is a break/interval")

    @model_validator(mode='after')
    def validate_blinds(self):
        """Validate that non-break levels have valid blind values"""
        if not self.is_break:
            if self.small_blind <= 0:
                raise ValueError("Small blind must be positive for non-break levels")
            if self.big_blind <= 0:
                raise ValueError("Big blind must be positive for non-break levels")
        return self


class BlindCreateRequest(BaseModel):
    """Request model for creating a blind (tournament_id/tournament_day_id comes from URL)"""
    level: int = Field(..., gt=0, description="Blind level number (must be positive)")
    small_blind: int = Field(default=0, ge=0, description="Small blind amount")
    big_blind: int = Field(default=0, ge=0, description="Big blind amount")
    ante: int = Field(default=0, ge=0, description="Ante amount (0 or positive)")
    duration: int = Field(default=15, gt=0, description="Duration in minutes (must be positive)")
    is_break: bool = Field(default=False, description="True if this is a break/interval")

    @model_validator(mode='after')
    def validate_blinds(self):
        """Validate that non-break levels have valid blind values"""
        if not self.is_break:
            if self.small_blind <= 0:
                raise ValueError("Small blind must be positive for non-break levels")
            if self.big_blind <= 0:
                raise ValueError("Big blind must be positive for non-break levels")
        return self


class BlindCreate(BlindBase):
    """Internal model for blind creation with tournament_id"""
    tournament_id: UUID = Field(..., description="UUID of the tournament")


class BlindCreateForDay(BlindBase):
    """Internal model for blind creation with tournament_day_id"""
    tournament_day_id: UUID = Field(..., description="UUID of the tournament day")


class BlindUpdate(BaseModel):
    level: Optional[int] = Field(None, gt=0, description="Blind level number")
    small_blind: Optional[int] = Field(None, ge=0, description="Small blind amount")
    big_blind: Optional[int] = Field(None, ge=0, description="Big blind amount")
    ante: Optional[int] = Field(None, ge=0, description="Ante amount")
    duration: Optional[int] = Field(None, gt=0, description="Duration in minutes")
    is_break: Optional[bool] = Field(None, description="True if this is a break/interval")


class BlindResponse(BaseModel):
    id: UUID
    level: int
    small_blind: int
    big_blind: int
    ante: int
    duration: int
    is_break: bool = False
    tournament_id: Optional[UUID] = None
    tournament_day_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class BlindReplicateDurationRequest(BaseModel):
    """Replicar a duração de um nível para os níveis SEGUINTES do mesmo tipo.

    `is_break` separa nível de intervalo: cada um tem a sua duração típica
    (15 e 10 min), e "a partir do nível 3 tudo vira 20 min" não pode esticar
    os intervalos junto.
    """
    after_level: int = Field(..., ge=1, description="Replicate to levels greater than this one")
    duration: int = Field(..., gt=0, description="Duration in minutes (must be positive)")
    is_break: bool = Field(default=False, description="Replicate only to rows of this kind (levels or breaks)")


class BlindReplicateDurationResponse(BaseModel):
    updated: int
    after_level: int
    duration: int
    is_break: bool
