"""Premiação por eliminação (KO fixo, PKO, Mystery) — corpos e respostas da API."""
from decimal import Decimal
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class EliminateRequest(BaseModel):
    """Corpo OPCIONAL da eliminação.

    Telas antigas mandam `{tournament_player_id}` (ou nada): continua valendo —
    os campos extras são ignorados. Em torneio KO, quem eliminou é obrigatório,
    salvo `no_eliminator` (abandono/desclassificação: o bounty vai ao campeão).
    """
    model_config = ConfigDict(extra="ignore")

    eliminated_by: List[str] = Field(default_factory=list, description="Inscrições (tournament_player) de quem eliminou; mais de uma = pote dividido")
    no_eliminator: bool = False
    client_mutation_id: Optional[str] = None


class EliminatorsUpdate(BaseModel):
    eliminated_by: List[str] = Field(default_factory=list)
    no_eliminator: bool = False


class KnockoutPayRequest(BaseModel):
    paid_by: Optional[str] = Field(None, max_length=255, description="Quem entregou o dinheiro (atendente)")
    # FIADO do eliminador: obrigatório quando ele deve (inclusive 0).
    debt_offset_amount: Optional[float] = Field(None, ge=0)
    debt_offset_reason: Optional[str] = Field(None, max_length=300)


class KnockoutBatchPayRequest(BaseModel):
    payout_ids: List[str] = Field(..., min_length=1)
    paid_by: Optional[str] = Field(None, max_length=255)
    # Abatimento por pagamento ({payout_id: valor}). Quem deve e não está aqui
    # para o lote no 409 jogador_com_fiado — os anteriores ficam pagos.
    debt_offsets: Optional[Dict[str, float]] = None


class KnockoutCloseRequest(BaseModel):
    champion_tp_id: str = Field(..., description="Inscrição do campeão: leva o próprio bounty e os sem autor")


class KnockoutManualRequest(BaseModel):
    """Prêmio Mystery entregue na mesa, registrado para o caixa pagar."""
    recipient_tp_id: str = Field(..., description="Inscrição de quem recebe o prêmio")
    value: Decimal = Field(..., gt=0)
    eliminated_tp_id: Optional[str] = Field(None, description="Quem foi eliminado (opcional, para o registro)")


class MysteryEnvelopeInput(BaseModel):
    value: Decimal = Field(..., gt=0)
    quantity: int = Field(..., ge=1)


class MysteryStartRequest(BaseModel):
    day_id: Optional[str] = None
    envelopes: List[MysteryEnvelopeInput] = Field(..., min_length=1)
    # 'system': o sistema sorteia; 'physical': envelopes de verdade, o staff
    # registra o que saiu no ponto de troca.
    draw_mode: str = Field("system", pattern="^(system|physical)$")


class EnvelopeExchangeRequest(BaseModel):
    """Sorteio físico: o valor do envelope que o jogador tirou."""
    value: Decimal = Field(..., gt=0)


class KnockoutPayoutOut(BaseModel):
    id: str
    knockout_id: str
    eliminator_tp_id: Optional[str] = None
    eliminator_player_id: Optional[str] = None
    eliminator_name: Optional[str] = None
    cash_amount: Decimal = Decimal("0")
    added_to_bounty: Decimal = Decimal("0")
    paid: bool = False
    paid_at: Optional[str] = None
    paid_by: Optional[str] = None
    # Pago com fiado: `cash_amount` continua bruto (o pozo KO fecha nele).
    debt_offset: Optional[Decimal] = None
    net_paid: Optional[Decimal] = None


class KnockoutOut(BaseModel):
    id: str
    kind: str
    format: str
    status: str
    created_at: Optional[str] = None
    eliminated_tp_id: Optional[str] = None
    eliminated_player_id: Optional[str] = None
    eliminated_name: Optional[str] = None
    bounty_value: Decimal = Decimal("0")
    cash_share: Decimal = Decimal("100")
    envelope_pending: bool = False
    payouts: List[KnockoutPayoutOut] = []


class PlayerBounty(BaseModel):
    tournament_player_id: str
    player_id: Optional[str] = None
    player_name: Optional[str] = None
    status: Optional[str] = None
    bounty: Decimal = Decimal("0")


class EnvelopeGroup(BaseModel):
    value: Decimal
    count: int


class MysteryInfo(BaseModel):
    started_at: Optional[str] = None
    day_id: Optional[str] = None
    pool: Optional[Decimal] = None
    players_at_start: Optional[int] = None
    envelopes_total: int = 0
    envelopes_remaining: int = 0
    remaining: List[EnvelopeGroup] = []
    draw_mode: str = "system"
    pending_draws: int = 0


class KnockoutSummary(BaseModel):
    tournament_id: str
    ko_format: str = "none"
    ko_percentage: Decimal = Decimal("0")
    ko_cash_share: Decimal = Decimal("100")
    closed_at: Optional[str] = None
    ko_pool: Decimal = Decimal("0")
    paid: Decimal = Decimal("0")
    pending: Decimal = Decimal("0")
    unclaimed: Decimal = Decimal("0")
    # Prêmios Mystery registrados à mão (envelopes abertos fora do sistema).
    manual_total: Decimal = Decimal("0")
    # Mystery: o pool das ENTRADAS, o garantido (o fundo é o maior dos dois)
    # e o nível em que a fase deve começar.
    entries_pool: Decimal = Decimal("0")
    mystery_guarantee: Decimal = Decimal("0")
    mystery_start_level: Optional[int] = None
    bounties: List[PlayerBounty] = []
    knockouts: List[KnockoutOut] = []
    mystery: Optional[MysteryInfo] = None


class EliminationKnockout(BaseModel):
    """O que a eliminação gerou de KO — para a tela já abrir o pagamento."""
    knockout: Optional[KnockoutOut] = None
