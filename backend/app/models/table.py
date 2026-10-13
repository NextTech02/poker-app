from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from datetime import datetime

# Assentos NÃO têm teto. O clube monta a mesa que o salão pede — uma de 11 na
# mesa final, uma de 4 para um heads-up alongado — e o número só precisa ser
# positivo. O limite de 10 que morava aqui e no CHECK do banco saiu em out/2026
# (migração mesas_assentos_sem_teto). O número da mesa também é escolha do
# operador: ele identifica a mesa física no salão, e a tela deixa trocar.


class TableBase(BaseModel):
    tournament_id: str = Field(..., description="Tournament ID")
    tournament_day_id: Optional[str] = Field(None, description="Tournament Day ID (day-scoped tables)")
    table_number: int = Field(..., gt=0, description="Table number (unique within the day)")
    seats: int = Field(..., gt=0, description="Number of seats at this table (no upper limit)")
    status: str = Field(default='active', description="Table status: active, broken, closed")


class TableCreate(BaseModel):
    table_number: int = Field(..., gt=0, description="Table number (unique within the day)")
    seats: int = Field(..., gt=0, description="Number of seats at this table (no upper limit)")


class TableUpdate(BaseModel):
    table_number: Optional[int] = Field(None, gt=0)
    seats: Optional[int] = Field(None, gt=0)
    status: Optional[str] = None


class SeatStatusUpdate(BaseModel):
    """Liga ou desliga UM assento da mesa (cadeira quebrada, lugar encostado
    na parede). Desligado, ele continua existindo — só não recebe jogador."""
    active: bool


class Table(TableBase):
    id: str
    occupied_seats: int = Field(default=0, description="Number of occupied seats")
    # Assentos desativados pelo floor. Quem escolhe cadeira pula esta lista.
    blocked_seats: List[int] = Field(default_factory=list, description="Disabled seat numbers")
    created_at: datetime
    updated_at: Optional[datetime] = None

    @field_validator("blocked_seats", mode="before")
    @classmethod
    def _lista_vazia_para_nulo(cls, valor):
        # Linha anterior à migração (ou fake de teste) vem sem a coluna/nula.
        return valor or []

    class Config:
        from_attributes = True


class TableWithPlayers(Table):
    """Table with player information"""
    players: list = Field(default_factory=list, description="List of players at this table")

    class Config:
        from_attributes = True
