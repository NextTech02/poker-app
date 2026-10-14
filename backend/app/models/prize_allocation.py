from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, Literal
from datetime import datetime
from uuid import UUID
from decimal import Decimal

from app.utils.documentos import TIPOS_ACEITOS

# Os MESMOS tipos do cadastro de jogador: os do país (DNI, cédula, CPF...) e
# os antigos. Era um Literal só com os três antigos, e jogador cadastrado com
# DNI não conseguia receber prêmio — a tela manda o tipo do cadastro e a API
# recusava com 422 antes de chegar ao caixa.
DocumentType = str


PrizeType = Literal['cash', 'vaga']


class PrizeAllocationBase(BaseModel):
    position: int = Field(..., gt=0, description="Finishing position (1 = winner)")
    prize_amount: Decimal = Field(default=Decimal("0"), ge=0, description="Prize amount (derived from target day buy-in when prize_type='vaga')")


class PrizeAllocationCreate(PrizeAllocationBase):
    """Request model for creating a prize allocation"""
    prize_type: PrizeType = 'cash'
    vaga_target_tournament_id: Optional[UUID] = None
    vaga_target_day_id: Optional[UUID] = None


class PrizeRangeCreate(PrizeAllocationCreate):
    """Uma FAIXA de colocações (ex.: 7 a 9) com o mesmo prêmio.

    Cada posição vira uma linha própria (o pagamento continua sendo por
    jogador, posição a posição); o telão agrupa de volta as posições
    consecutivas de mesmo valor e mostra "7º–9º Lugar : S/ 400".
    """
    position_end: int = Field(..., gt=0, description="Última posição da faixa (inclusive)")

    @model_validator(mode="after")
    def _faixa_valida(self):
        if self.position_end < self.position:
            raise ValueError("position_end must be greater than or equal to position")
        if self.position_end - self.position + 1 > 200:
            raise ValueError("Range too large (max 200 positions)")
        return self


class PrizeAllocationUpdate(BaseModel):
    position: Optional[int] = Field(None, gt=0)
    prize_amount: Optional[Decimal] = Field(None, ge=0)
    player_id: Optional[UUID] = None
    paid: Optional[bool] = None
    released: Optional[bool] = None
    visible: Optional[bool] = None
    prize_type: Optional[PrizeType] = None
    vaga_target_tournament_id: Optional[UUID] = None
    vaga_target_day_id: Optional[UUID] = None


class PrizePayoutRequest(BaseModel):
    """Request model for processing a prize payout with document verification"""
    player_id: UUID
    document_type: DocumentType = Field(..., min_length=1, max_length=30,
                                        description=f"Um de: {', '.join(TIPOS_ACEITOS)}")
    document_number: str = Field(..., min_length=1, max_length=100)
    paid_by: Optional[str] = Field(None, max_length=255, description="Name of staff processing payment")

    @field_validator("document_type")
    @classmethod
    def _tipo_do_cadastro(cls, valor: str) -> str:
        if valor not in TIPOS_ACEITOS:
            raise ValueError(f"Input should be one of: {', '.join(TIPOS_ACEITOS)}")
        return valor


class PrizeAllocationResponse(BaseModel):
    id: UUID
    tournament_id: UUID
    position: int
    prize_amount: Decimal
    player_id: Optional[UUID] = None
    player_name: Optional[str] = None  # Joined from players table
    paid: bool = False
    paid_at: Optional[datetime] = None
    document_type: Optional[str] = None
    document_number: Optional[str] = None
    paid_by: Optional[str] = None
    released: bool = False
    released_at: Optional[datetime] = None
    visible: bool = True
    prize_type: str = 'cash'
    vaga_target_tournament_id: Optional[UUID] = None
    vaga_target_day_id: Optional[UUID] = None
    generated_ticket_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PrizeAllocationBulkCreate(BaseModel):
    """Request model for bulk creating prize allocations"""
    allocations: list[PrizeAllocationCreate]


class PrizeSummary(BaseModel):
    """Summary of prize pool for a tournament (sum of all days)"""
    tournament_id: UUID
    guaranteed_prize: Decimal = Decimal("0")
    total_entries: Decimal = Decimal("0")  # Total buy-ins + rebuys + addons from ALL days
    rake_percentage: Decimal = Decimal("20")  # Default 20% (average of non-final days)
    player_pool: Decimal = Decimal("0")  # entries after rake
    available_prize_pool: Decimal = Decimal("0")  # guaranteed + player_pool (gross)
    reserved_prize_percentage: Decimal = Decimal("0")  # % blocked for ranking/staff
    reserved_purpose: Optional[str] = None  # 'ranking' | 'staff'
    reserved_amount: Decimal = Decimal("0")  # available_prize_pool * reserved% (blocked)
    payable_pool: Decimal = Decimal("0")  # available_prize_pool - reserved_amount (what players can receive)
    total_allocated: Decimal = Decimal("0")  # Sum of all prize allocations
    remaining_balance: Decimal = Decimal("0")  # payable_pool - allocated
    # Premiação por eliminação: o pozo líquido (entradas − rake) se divide
    # entre o pozo KO e o das posições (player_pool, acima).
    net_pool: Decimal = Decimal("0")  # entradas − rake (o pozo acumulado inteiro)
    ko_format: str = "none"
    ko_percentage: Decimal = Decimal("0")
    ko_pool: Decimal = Decimal("0")  # Σ parte KO das vendas (ou o pozo Mystery congelado)
    total_prize_pool: Decimal = Decimal("0")  # posições disponíveis + KO (o que o telão mostra)
    allocations: list[PrizeAllocationResponse] = []
    has_qualifying_days: bool = False  # True if tournament has qualifying structure


class BroadcastPrize(BaseModel):
    """Uma faixa de premiação como o telão a mostra: só posição e valor."""
    position: int
    prize_amount: Decimal


class BroadcastPrizes(BaseModel):
    """O que a TV do salão precisa saber sobre a premiação, e NADA além disso.

    A tela de transmissão é pública (abre pelo código da TV, sem login), e o
    PrizeSummary completo leva junto rake, entradas brutas, reserva e quem já
    foi pago — nada disso é para o salão. Aqui vai só o prizepool disponível e
    as faixas marcadas como visíveis.
    """
    prize_pool: Decimal = Decimal("0")
    prizes: list[BroadcastPrize] = []
