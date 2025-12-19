from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime, date


class StageBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Stage name (e.g., 'Etapa Bogotá')")
    location: str = Field(..., min_length=1, max_length=255, description="Stage location/city")
    start_date: Optional[date] = Field(None, description="Stage start date")
    end_date: Optional[date] = Field(None, description="Stage end date")
    description: Optional[str] = Field(None, description="Stage description")
    status: str = Field(default='upcoming', description="Stage status: upcoming, active, completed, cancelled")


class StageCreate(StageBase):
    pass


class StageUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    location: Optional[str] = Field(None, max_length=255)
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None
    status: Optional[str] = None


class Stage(StageBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class StageSummary(BaseModel):
    """Stage summary with tournament count"""
    id: str
    name: str
    location: str
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    description: Optional[str] = None
    status: str
    tournament_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True
