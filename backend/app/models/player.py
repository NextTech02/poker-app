from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import Optional, Literal
from datetime import datetime


def _blank_to_none(v):
    # Data vem do form como string 'YYYY-MM-DD' (ou '' quando vazia). Mantemos
    # string (o Postgres aceita para coluna date) e tratamos vazio como null.
    if v in (None, ""):
        return None
    return v


class PlayerBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255, description="Full name (required)")
    email: EmailStr = Field(..., description="Email address (required, unique)")
    phone: str = Field(..., min_length=1, max_length=50, description="Phone number with country code (required)")
    nationality: str = Field(..., min_length=1, max_length=100, description="Nationality/Country (required)")
    document_type: Literal['passport', 'national_id', 'driver_license'] = Field(..., description="Type of identification document")
    document_number: str = Field(..., min_length=1, max_length=100, description="Document number (required)")
    nickname: Optional[str] = Field(None, max_length=100, description="Player nickname (optional)")
    birth_date: Optional[str] = Field(None, description="Birth date 'YYYY-MM-DD' (optional) — loyalty birthday bonus")
    notes: Optional[str] = Field(None, description="Additional notes (optional)")

    @field_validator("birth_date", mode="before")
    @classmethod
    def _bd_base(cls, v):
        return _blank_to_none(v)


class PlayerCreate(PlayerBase):
    # Offline: id gerado no cliente (vira o PK; idempotência no replay).
    client_id: Optional[str] = Field(default=None, description="Client-generated player id (offline)")


class PlayerUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=50)
    nationality: Optional[str] = Field(None, max_length=100)
    document_type: Optional[Literal['passport', 'national_id', 'driver_license']] = None
    document_number: Optional[str] = Field(None, max_length=100)
    nickname: Optional[str] = Field(None, max_length=100)
    birth_date: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("birth_date", mode="before")
    @classmethod
    def _bd_upd(cls, v):
        return _blank_to_none(v)


class Player(PlayerBase):
    id: str
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class PlayerStats(BaseModel):
    """Player statistics from the player_statistics view (org-scoped via RLS)."""
    id: str
    name: str
    nickname: Optional[str] = None
    tournaments_played: int = 0
    entries: int = 0            # participações (linhas em tournament_players)
    days_played: int = 0
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0
    total_buy_in_amount: float = 0.0
    total_rebuy_amount: float = 0.0
    total_addon_amount: float = 0.0
    total_spent: float = 0.0
    total_prizes: float = 0.0
    net_profit: float = 0.0
    first_places: int = 0
    top_3_finishes: int = 0
    itm_count: int = 0          # in the money (nº de premiações)
    eliminated_count: int = 0
    best_position: Optional[int] = None
    avg_position: Optional[float] = None
    first_played: Optional[str] = None
    last_played: Optional[str] = None
    win_rate: float = 0.0       # 0..1 — % de 1º lugar
    itm_rate: float = 0.0       # 0..1 — % de vezes no dinheiro
    rebuy_rate: float = 0.0     # rebuys por participação
    roi: float = 0.0            # lucro / investido
    final_tables: int = 0       # mesas finais alcançadas (final_position 1..9)
    hours_played: float = 0.0   # horas jogadas (Σ eliminated_at − registered_at)

    class Config:
        from_attributes = True


class PlayerHistoryEntry(BaseModel):
    """Uma participação do jogador (linha do histórico)."""
    tournament_player_id: str
    tournament_id: Optional[str] = None
    tournament_name: Optional[str] = None
    tournament_day_id: Optional[str] = None
    day_name: Optional[str] = None
    registered_at: Optional[str] = None
    status: Optional[str] = None
    buy_in_count: int = 0
    rebuy_count: int = 0
    addon_count: int = 0
    total_spent: float = 0.0
    final_position: Optional[int] = None
    prize_won: float = 0.0

    class Config:
        from_attributes = True
