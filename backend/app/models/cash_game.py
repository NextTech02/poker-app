"""Modelos do módulo de CASH GAME.

A unidade de operação é o DIA, não a etapa. Torneio se organiza em etapas
(circuitos com começo e fim); cash game abre, roda a noite, conta e fecha —
todo dia. É esse o recorte que responde "quanto faturamos ontem?" e "vale
abrir na terça?".

DOIS NÚMEROS QUE NÃO SE MISTURAM:
  - o que passa pela GAVETA: buy-in e rebuy entram, cash-out sai;
  - o que é RECEITA: o rake apurado na contagem da caixa da mesa.
O rake sai do pote, em fichas, e já está na gaveta como a diferença entre os
dois primeiros. Somá-lo à gaveta contaria o mesmo dinheiro duas vezes.
"""
from datetime import date, datetime
from typing import List, Optional

from pydantic import BaseModel, Field


# ────────────────────────────────────────────────
# Dia de operação
# ────────────────────────────────────────────────

class CashDayCreate(BaseModel):
    # A data é ESCOLHIDA, nunca deduzida do relógio: a noite que começa 21h e
    # termina 05h é um dia só. Com `now()::date` o faturamento da madrugada
    # cairia no dia seguinte e o relatório de melhores dias ficaria torto.
    business_date: date
    label: Optional[str] = Field(None, max_length=160)
    notes: Optional[str] = None


class CashDayClose(BaseModel):
    notes: Optional[str] = None


class CashDayResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    business_date: date
    label: Optional[str] = None
    status: str
    opened_at: datetime
    opened_by: Optional[str] = None
    closed_at: Optional[datetime] = None
    closed_by: Optional[str] = None
    # Congelados no fechamento; None enquanto aberto (a leitura ao vivo agrega).
    total_buy_ins: Optional[float] = None
    total_cash_outs: Optional[float] = None
    total_rake: Optional[float] = None
    total_jackpot: Optional[float] = None
    variance: Optional[float] = None
    tables_count: Optional[int] = None
    players_count: Optional[int] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CashDaySummary(BaseModel):
    """Os números do dia, ao vivo ou congelados.

    `revenue` é o RAKE — não os buy-ins. Buy-in não é receita: é troca de
    dinheiro por ficha, e a maior parte volta ao jogador no cash-out. Confundir
    os dois multiplica o faturamento do clube por dez no papel.
    """
    cash_day_id: str
    business_date: date
    status: str
    total_buy_ins: float = 0.0
    total_cash_outs: float = 0.0
    revenue: float = 0.0            # rake apurado = receita da casa
    jackpot_collected: float = 0.0  # PASSIVO: fundo dos jogadores, não receita
    # (buy_ins - cash_outs) - (rake + jackpot). Diferente de zero é esperado
    # enquanto houver jogador sentado ou jackpot retido em fichas.
    variance: float = 0.0
    tables_open: int = 0
    tables_total: int = 0
    players_seated: int = 0
    players_total: int = 0
    cash_in_play: float = 0.0       # fichas na mesa: sentados que ainda não saíram


# ────────────────────────────────────────────────
# Modalidades (stakes)
# ────────────────────────────────────────────────

class CashGameTypeBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    game_variant: str = Field("nlh", pattern="^(nlh|plo|plo5|loh|mixed|other)$")
    small_blind: float = Field(..., gt=0)
    big_blind: float = Field(..., gt=0)
    ante: float = Field(0, ge=0)
    straddle_allowed: bool = False
    min_buy_in: float = Field(..., gt=0)
    max_buy_in: Optional[float] = Field(None, gt=0)   # None = sem teto
    default_seats: int = Field(9, ge=2, le=10)
    rake_percent: float = Field(5, ge=0, le=100)
    rake_cap: float = Field(0, ge=0)                  # 0 = sem teto
    jackpot_per_pot: float = Field(0, ge=0)
    active: bool = True
    sort_order: int = 0


class CashGameTypeCreate(CashGameTypeBase):
    pass


class CashGameTypeUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=120)
    game_variant: Optional[str] = Field(None, pattern="^(nlh|plo|plo5|loh|mixed|other)$")
    small_blind: Optional[float] = Field(None, gt=0)
    big_blind: Optional[float] = Field(None, gt=0)
    ante: Optional[float] = Field(None, ge=0)
    straddle_allowed: Optional[bool] = None
    min_buy_in: Optional[float] = Field(None, gt=0)
    max_buy_in: Optional[float] = Field(None, gt=0)
    default_seats: Optional[int] = Field(None, ge=2, le=10)
    rake_percent: Optional[float] = Field(None, ge=0, le=100)
    rake_cap: Optional[float] = Field(None, ge=0)
    jackpot_per_pot: Optional[float] = Field(None, ge=0)
    active: Optional[bool] = None
    sort_order: Optional[int] = None


class CashGameTypeResponse(CashGameTypeBase):
    id: str
    organization_id: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Mesa
# ────────────────────────────────────────────────

class CashTableCreate(BaseModel):
    cash_day_id: str
    game_type_id: str
    table_number: int = Field(..., gt=0)
    # Sobrepõe o padrão da modalidade quando a mesa física tem outro tamanho.
    seats: Optional[int] = Field(None, ge=2, le=10)
    notes: Optional[str] = None


class CashTableUpdate(BaseModel):
    table_number: Optional[int] = Field(None, gt=0)
    seats: Optional[int] = Field(None, ge=2, le=10)
    status: Optional[str] = Field(None, pattern="^(open|paused)$")
    notes: Optional[str] = None


class CashTableClose(BaseModel):
    """Fechamento da mesa: a CONTAGEM da caixa de rake.

    Este é o momento em que a receita do cash vira número. Os valores são o que
    o sangeur contou — o sistema não vê mão a mão e não tem como calcular.
    """
    rake_amount: float = Field(..., ge=0)
    jackpot_amount: float = Field(0, ge=0)
    notes: Optional[str] = None


class CashSeatResponse(BaseModel):
    id: str
    table_id: str
    seat_number: int
    status: str
    player_session_id: Optional[str] = None
    reserved_for: Optional[str] = None
    reserved_until: Optional[datetime] = None
    # Enriquecido para a tela não precisar de uma segunda chamada por cadeira.
    player_id: Optional[str] = None
    player_name: Optional[str] = None
    total_buy_in: Optional[float] = None
    seated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class CashTableResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    cash_day_id: str
    game_type_id: Optional[str] = None
    table_number: int
    seats: int
    game_variant: str
    small_blind: float
    big_blind: float
    ante: float = 0
    min_buy_in: float
    max_buy_in: Optional[float] = None
    rake_percent: float = 0
    rake_cap: float = 0
    jackpot_per_pot: float = 0
    status: str
    opened_at: datetime
    closed_at: Optional[datetime] = None
    rake_counted: Optional[float] = None
    jackpot_counted: Optional[float] = None
    notes: Optional[str] = None
    # Agregados ao vivo
    game_type_name: Optional[str] = None
    occupied_seats: int = 0
    free_seats: int = 0
    total_buy_ins: float = 0.0
    total_cash_outs: float = 0.0
    rake_partial: float = 0.0      # soma das apurações já lançadas
    jackpot_partial: float = 0.0

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Sessão do jogador
# ────────────────────────────────────────────────

class SitPlayer(BaseModel):
    """Sentar o jogador: cadeira + primeira compra de fichas, num passo só.

    Os dois juntos de propósito — sentar sem pagar deixaria uma cadeira ocupada
    por um jogador sem fichas, que é um estado que não existe na mesa real.
    """
    player_id: str
    buy_in_amount: float = Field(..., gt=0)
    payment_method: Optional[str] = None
    payment_source: Optional[str] = None
    client_mutation_id: Optional[str] = None
    notes: Optional[str] = None


class StandPlayer(BaseModel):
    """Levantar o jogador: devolve as fichas e fecha a sessão.

    Zero é válido: quem perdeu tudo levanta sem receber nada, e a sessão precisa
    fechar do mesmo jeito.
    """
    cash_out_amount: float = Field(..., ge=0)
    payment_method: Optional[str] = None
    client_mutation_id: Optional[str] = None
    notes: Optional[str] = None


class CashRebuy(BaseModel):
    amount: float = Field(..., gt=0)
    payment_method: Optional[str] = None
    payment_source: Optional[str] = None
    client_mutation_id: Optional[str] = None
    notes: Optional[str] = None


class CashPlayerSessionResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    cash_day_id: str
    table_id: str
    player_id: str
    seat_number: int
    status: str
    started_at: datetime
    ended_at: Optional[datetime] = None
    total_buy_in: float = 0.0
    total_cash_out: float = 0.0
    result: float = 0.0
    moved_to_id: Optional[str] = None
    notes: Optional[str] = None
    # Enriquecido
    player_name: Optional[str] = None
    table_number: Optional[int] = None

    class Config:
        from_attributes = True


# ────────────────────────────────────────────────
# Dinheiro
# ────────────────────────────────────────────────

class CashTransactionResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    cash_day_id: str
    table_id: Optional[str] = None
    player_session_id: Optional[str] = None
    player_id: Optional[str] = None
    type: str
    amount: float
    payment_method: Optional[str] = None
    payment_source: Optional[str] = None
    cashbox_id: Optional[str] = None
    status: str = "active"
    cancelled_at: Optional[datetime] = None
    cancel_reason: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime
    # Enriquecido
    player_name: Optional[str] = None
    table_number: Optional[int] = None

    class Config:
        from_attributes = True


class CashTransactionCancel(BaseModel):
    # Obrigatório: é o que explica a diferença no fechamento do caixa. Sem o
    # motivo, o conferente vê dinheiro a menos e nenhuma justificativa.
    reason: str = Field(..., min_length=3, max_length=500)


# ────────────────────────────────────────────────
# Apuração de rake
# ────────────────────────────────────────────────

class CashRakeEntryCreate(BaseModel):
    rake_amount: float = Field(0, ge=0)
    jackpot_amount: float = Field(0, ge=0)
    notes: Optional[str] = None


class CashRakeEntryResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    cash_day_id: str
    table_id: str
    kind: str
    rake_amount: float
    jackpot_amount: float
    counted_by: Optional[str] = None
    counted_at: datetime
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class SitPlayerResult(BaseModel):
    """O que a tela precisa depois de sentar alguém, sem uma segunda chamada."""
    player_session: CashPlayerSessionResponse
    transaction: CashTransactionResponse
    seat: CashSeatResponse

# ────────────────────────────────────────────────
# Fila de espera
# ────────────────────────────────────────────────

class CashWaitlistCreate(BaseModel):
    """Entrar na fila.

    `player_id` OU `guest_name`: o visitante que chega pela primeira vez entra
    na fila ANTES de virar cadastro. Exigir o cadastro primeiro faria o operador
    digitar documento com cinco pessoas esperando no balcão — e na prática ele
    anotaria num papel, que é o que a fila veio substituir.
    """
    player_id: Optional[str] = None
    guest_name: Optional[str] = Field(None, max_length=160)
    # Fila por modalidade (quero NLH 1/2 em qualquer mesa) ou por mesa
    # específica. Nenhum dos dois = fila geral.
    game_type_id: Optional[str] = None
    table_id: Optional[str] = None
    notes: Optional[str] = None


class CashWaitlistUpdate(BaseModel):
    # A posição é editável porque na sala real alguém cede a vez. O que não se
    # faz é reordenar sozinho: a ordem é o combinado com quem está esperando.
    position: Optional[int] = Field(None, ge=1)
    notes: Optional[str] = None


class CashWaitlistSeat(BaseModel):
    table_id: str
    seat_number: int = Field(..., gt=0)
    # Minutos de reserva. A cadeira fica presa enquanto o jogador vem do bar;
    # sem prazo, uma chamada esquecida travaria o lugar a noite inteira.
    minutes: int = Field(10, ge=1, le=120)


class CashWaitlistResponse(BaseModel):
    id: str
    organization_id: Optional[str] = None
    cash_day_id: str
    game_type_id: Optional[str] = None
    table_id: Optional[str] = None
    player_id: Optional[str] = None
    guest_name: Optional[str] = None
    position: int
    status: str
    called_at: Optional[datetime] = None
    seated_at: Optional[datetime] = None
    seat_id: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None
    # Enriquecido
    player_name: Optional[str] = None
    game_type_name: Optional[str] = None
    table_number: Optional[int] = None

    class Config:
        from_attributes = True


class SeatReserve(BaseModel):
    player_id: Optional[str] = None
    minutes: int = Field(10, ge=1, le=120)


class MovePlayer(BaseModel):
    """Trocar o jogador de mesa sem passar pelo caixa.

    O dinheiro NÃO se mexe: ele levou as fichas com ele. A sessão antiga fecha
    encadeada na nova (`moved_to_id`), e o resultado da noite dele soma a
    corrente inteira — tratar como cash-out + buy-in inflaria o giro do dia com
    dinheiro que nunca passou pela gaveta.
    """
    to_table_id: str
    to_seat: int = Field(..., gt=0)
