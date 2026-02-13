from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from uuid import UUID


class BlindLevel(BaseModel):
    """Individual blind level within a template"""
    level: int = Field(..., gt=0, description="Blind level number")
    small_blind: int = Field(default=0, ge=0, description="Small blind amount")
    big_blind: int = Field(default=0, ge=0, description="Big blind amount")
    ante: int = Field(default=0, ge=0, description="Ante amount")
    duration: int = Field(default=15, gt=0, description="Duration in minutes")
    is_break: bool = Field(default=False, description="True if this is a break")


class BlindTemplateBase(BaseModel):
    """Base model for blind template"""
    name: str = Field(..., min_length=1, max_length=100, description="Template name")
    description: Optional[str] = Field(None, description="Template description")

    # Blind configuration for auto-generation
    blind_duration: int = Field(default=15, gt=0, description="Default duration per level in minutes")
    initial_small_blind: int = Field(default=25, gt=0, description="Starting small blind")
    initial_big_blind: int = Field(default=50, gt=0, description="Starting big blind")
    blind_increase_type: str = Field(default="double", description="How blinds increase: 'double', 'gradual', 'custom'")
    bb_ante_start_level: Optional[int] = Field(default=3, ge=1, description="Level at which ante starts")

    # Optional custom levels
    custom_levels: Optional[List[BlindLevel]] = Field(None, description="Custom blind levels array")

    # Break configuration
    break_interval: Optional[int] = Field(default=60, ge=0, description="Break interval in minutes")
    break_duration: Optional[int] = Field(default=10, ge=0, description="Break duration in minutes")


class BlindTemplateCreate(BlindTemplateBase):
    """Model for creating a blind template"""
    stage_id: Optional[UUID] = Field(None, description="Optional stage to associate template with")


class BlindTemplateUpdate(BaseModel):
    """Model for updating a blind template"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = None
    blind_duration: Optional[int] = Field(None, gt=0)
    initial_small_blind: Optional[int] = Field(None, gt=0)
    initial_big_blind: Optional[int] = Field(None, gt=0)
    blind_increase_type: Optional[str] = None
    bb_ante_start_level: Optional[int] = Field(None, ge=1)
    custom_levels: Optional[List[BlindLevel]] = None
    break_interval: Optional[int] = Field(None, ge=0)
    break_duration: Optional[int] = Field(None, ge=0)


class BlindTemplateResponse(BlindTemplateBase):
    """Response model for blind template"""
    id: UUID
    stage_id: Optional[UUID] = None
    created_by: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ApplyTemplateRequest(BaseModel):
    """Request to apply a template to a tournament day"""
    template_id: UUID = Field(..., description="ID of the template to apply")
    tournament_day_id: UUID = Field(..., description="ID of the tournament day to apply blinds to")
    clear_existing: bool = Field(default=True, description="Clear existing blinds before applying template")
