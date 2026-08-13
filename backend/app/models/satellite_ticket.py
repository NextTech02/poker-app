from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime


class TicketCreate(BaseModel):
    """New simplified flow: ticket is bound to a player + target tournament + day.
    The value is derived server-side from the target day's buy_in.
    `won_at` is a free-text label of where the ticket was won (may be an
    external platform such as PokerStars / GGPoker). `funded_by` is who is
    financially responsible for honoring the ticket value."""
    player_id: str
    target_tournament_id: str
    target_tournament_day_id: str
    won_at: str = Field(..., min_length=1, max_length=200)
    funded_by: str = Field(..., min_length=1, max_length=120)
    stage_id: Optional[str] = None


class TicketResponse(BaseModel):
    id: str
    # satellite_name kept optional for backward compatibility with legacy tickets
    satellite_name: Optional[str] = None
    target_tournament_id: str
    target_tournament_day_id: Optional[str] = None
    player_id: Optional[str] = None
    ticket_value: float
    status: str
    redeemed_at: Optional[datetime] = None
    redeemed_tournament_player_id: Optional[str] = None
    funded_by: Optional[str] = None
    won_at: Optional[str] = None
    stage_id: Optional[str] = None
    notes: Optional[str] = None
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    # Joined
    player_name: Optional[str] = None
    player_nickname: Optional[str] = None
    target_tournament_name: Optional[str] = None
    target_day_name: Optional[str] = None

    class Config:
        from_attributes = True


class TicketRedeem(BaseModel):
    """Redeems a ticket. The player and funder are already attached at
    creation time; `funded_by` here is only needed for legacy tickets that
    were created before the funder became a creation-time field."""
    funded_by: Optional[str] = Field(default=None, max_length=120)


class TicketSummary(BaseModel):
    total_available: int = 0
    total_redeemed: int = 0
    total_cancelled: int = 0


# ── Emissão em lote (só o "master" do clube) ────────────────────────────────


class TicketBulkCreate(BaseModel):
    """Vários jogadores, o MESMO destino (torneio + dia) e a mesma origem.

    Quem ganhou a vaga e quem a bancou valem para o lote inteiro: o caso real é
    o clube fechar um satélite e emitir a vaga de todos os classificados de uma
    vez. Se a origem variar por jogador, é outra emissão.

    O teto de 100 não é estético: cada ticket é uma entrada já paga que entra no
    pool do torneio-destino, e um lote sem limite vira um prejuízo sem limite.
    """
    player_ids: List[str] = Field(..., min_length=1, max_length=100)
    target_tournament_id: str
    target_tournament_day_id: str
    won_at: str = Field(..., min_length=1, max_length=200)
    funded_by: str = Field(..., min_length=1, max_length=120)
    stage_id: Optional[str] = None


class TicketBulkSkipped(BaseModel):
    """Jogador que ficou de fora do lote, com o motivo — o operador precisa
    saber QUEM não recebeu a vaga para resolver na mão."""
    player_id: str
    reason: str


class TicketBulkResult(BaseModel):
    created: List[TicketResponse] = []
    skipped: List[TicketBulkSkipped] = []
    total_value: float = 0


# ── Troca de dono: transferência e venda ────────────────────────────────────


class TicketTransfer(BaseModel):
    """Passa o ticket para outro jogador.

    `amount` = 0 é transferência simples (o jogador cedeu a vaga); > 0 é venda,
    e aí o dinheiro precisa entrar em algum lugar — daí `register_in_cash`.
    """
    to_player_id: str
    amount: float = Field(default=0, ge=0)
    payment_method: Optional[str] = Field(default=None, max_length=60)
    register_in_cash: bool = True
    notes: Optional[str] = Field(default=None, max_length=300)


class TicketTransferEntry(BaseModel):
    id: str
    ticket_id: str
    from_player_id: Optional[str] = None
    to_player_id: str
    kind: str
    amount: float = 0
    payment_method: Optional[str] = None
    stage_id: Optional[str] = None
    revenue_id: Optional[str] = None
    notes: Optional[str] = None
    performed_by: Optional[str] = None
    created_at: datetime
    # Joined
    from_player_name: Optional[str] = None
    to_player_name: Optional[str] = None

    class Config:
        from_attributes = True
