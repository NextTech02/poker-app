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

    # Chave-mestra de bloqueio de vendas: quando ligada, nenhum dia da etapa
    # vende. Declarada só aqui (e não em StageBase) para que a CRIAÇÃO da etapa
    # não tente gravar a coluna enquanto a migração não tiver rodado.
    sales_blocked: bool = False
    sales_blocked_reason: Optional[str] = None
    sales_blocked_at: Optional[datetime] = None
    sales_blocked_by: Optional[str] = None

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
    # Chega de graça: a RPC devolve a linha inteira da etapa e a consulta de
    # reserva usa select("*"). Sem a coluna (migração pendente) fica False, que
    # é o comportamento de hoje.
    sales_blocked: bool = False
    sales_blocked_reason: Optional[str] = None

    class Config:
        from_attributes = True
