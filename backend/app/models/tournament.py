from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class TournamentStatus(str, Enum):
    pending = "pending"
    active = "active"
    completed = "completed"
    cancelled = "cancelled"


class BlindIncreaseType(str, Enum):
    double = "double"
    triple = "triple"
    one_half = "1.5x"
    two_x = "2x"
    three_x = "3x"


class AllocationType(str, Enum):
    automatic = "automatic"
    manual = "manual"


class EliminationMode(str, Enum):
    """Como o diretor elimina jogadores — escolhido na criação do torneio.

    Os dois modos seguem a MESMA conta (ATIVOS = ENTRADAS − ELIMINAÇÕES, e toda
    reentrada traz de volta um eliminado); muda só quem mexe no contador:

    - `table` (por posição nas mesas): o jogador é eliminado no assento. Mais
      organizado — o sistema sabe QUEM saiu, e o contador é a contagem deles.
    - `bulk` (em massa): o diretor clica "Eliminar 1 / Eliminar N" no Controle.
      Mais prático — o contador não sabe quem saiu.
    """
    table = "table"
    bulk = "bulk"


class KoFormat(str, Enum):
    """Premiação por eliminação. Uma parte do pozo (`ko_percentage` do valor
    líquido de cada venda) sai das posições e vira prêmio por KO:

    - `ko`: KO fixo — quem elimina leva o bounty inteiro da vítima;
    - `pko`: progressivo — `ko_cash_share`% em dinheiro, o resto soma no
      bounty de quem eliminou;
    - `mystery`: envelopes sorteados a cada eliminação, depois que o floor
      inicia a fase.

    Exige eliminação por MESA: o modo em massa não sabe quem saiu.
    """
    none = "none"
    ko = "ko"
    pko = "pko"
    mystery = "mystery"


class BroadcastSettings(BaseModel):
    """Broadcast display settings for tournament"""
    bg_color: Optional[str] = Field(default="#0a0e13", description="Background color (hex)")
    bg_image_url: Optional[str] = Field(default=None, description="Background image URL")
    display_name: Optional[str] = Field(default=None, description="Custom display name")
    show_logo: bool = Field(default=True, description="Show logo")
    show_title: bool = Field(default=True, description="Show tournament title")
    show_prizepool: bool = Field(default=True, description="Show prizepool")
    show_level: bool = Field(default=True, description="Show blind level")
    show_players: bool = Field(default=True, description="Show player count")
    show_interval: bool = Field(default=True, description="Show interval until break")
    show_timer: bool = Field(default=True, description="Show countdown timer")
    show_blinds: bool = Field(default=True, description="Show current blinds")
    show_ante: bool = Field(default=True, description="Show ante value")
    show_next_blind: bool = Field(default=True, description="Show next blind")
    font_size: int = Field(default=100, ge=50, le=200, description="Font size percentage (50-200)")


class TournamentBase(BaseModel):
    """Simplified tournament model - just a container for tournament days"""
    name: str = Field(..., min_length=1, max_length=255, description="Tournament name (e.g., 'Torneio de Sexta')")
    stage_id: Optional[str] = Field(None, description="Stage/Etapa ID")
    sponsor_id: Optional[str] = Field(None, description="Sponsor/Patrocinador ID")
    has_qualifying: bool = Field(default=False, description="Whether this tournament has qualifying days leading to a final")
    is_satellite: bool = Field(default=False, description="Whether this is a satellite tournament that awards tickets")
    elimination_mode: EliminationMode = Field(
        default=EliminationMode.bulk,
        description="Como eliminar jogadores: 'table' (no assento) ou 'bulk' (contador em massa)",
    )
    ko_format: KoFormat = Field(default=KoFormat.none, description="Premiação por eliminação")
    ko_percentage: float = Field(default=0, ge=0, le=100, description="% do valor de cada venda que vai para KO (limitado ao líquido, valor − rake)")
    ko_cash_share: float = Field(default=50, ge=0, le=100, description="PKO: % do bounty pago em dinheiro")


class TournamentCreate(TournamentBase):
    pass


class TournamentUpdate(BaseModel):
    """Update model for simplified tournament"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    stage_id: Optional[str] = None
    sponsor_id: Optional[str] = Field(None, description="Sponsor/Patrocinador ID (null clears it)")
    has_qualifying: Optional[bool] = None
    is_satellite: Optional[bool] = None
    elimination_mode: Optional[EliminationMode] = None
    ko_format: Optional[KoFormat] = None
    ko_percentage: Optional[float] = Field(None, ge=0, le=100)
    ko_cash_share: Optional[float] = Field(None, ge=0, le=100)
    # Broadcast settings
    broadcast_bg_color: Optional[str] = Field(default=None, description="Background color (hex)")
    broadcast_bg_image_url: Optional[str] = Field(default=None, description="Background image URL")
    broadcast_display_name: Optional[str] = Field(default=None, description="Custom display name")
    broadcast_show_logo: Optional[bool] = Field(default=None, description="Show logo")
    broadcast_show_title: Optional[bool] = Field(default=None, description="Show tournament title")
    broadcast_show_prizepool: Optional[bool] = Field(default=None, description="Show prizepool")
    broadcast_show_level: Optional[bool] = Field(default=None, description="Show blind level")
    broadcast_show_players: Optional[bool] = Field(default=None, description="Show player count")
    broadcast_show_interval: Optional[bool] = Field(default=None, description="Show interval until break")
    broadcast_show_timer: Optional[bool] = Field(default=None, description="Show countdown timer")
    broadcast_show_blinds: Optional[bool] = Field(default=None, description="Show current blinds")
    broadcast_show_ante: Optional[bool] = Field(default=None, description="Show ante value")
    broadcast_show_next_blind: Optional[bool] = Field(default=None, description="Show next blind")
    broadcast_font_size: Optional[int] = Field(default=None, ge=50, le=200, description="Font size percentage (50-200)")


class Tournament(TournamentBase):
    """Complete tournament model - simplified to be just a container"""
    id: str
    created_by: str
    created_at: datetime
    updated_at: Optional[datetime] = None
    status: str = "pending"
    guaranteed_prize: float = 0.0
    sponsor_id: Optional[str] = None
    sponsor_name: Optional[str] = None  # joined from sponsors table
    # Estado do KO (só leitura: mexido pelos endpoints de KO)
    ko_closed_at: Optional[datetime] = None
    mystery_started_at: Optional[datetime] = None
    mystery_day_id: Optional[str] = None
    mystery_pool: Optional[float] = None
    mystery_players_at_start: Optional[int] = None
    # Broadcast settings
    broadcast_bg_color: Optional[str] = "#0a0e13"
    broadcast_bg_image_url: Optional[str] = None
    broadcast_display_name: Optional[str] = None
    broadcast_show_logo: bool = True
    broadcast_show_title: bool = True
    broadcast_show_prizepool: bool = True
    broadcast_show_level: bool = True
    broadcast_show_players: bool = True
    broadcast_show_interval: bool = True
    broadcast_show_timer: bool = True
    broadcast_show_blinds: bool = True
    broadcast_show_ante: bool = True
    broadcast_show_next_blind: bool = True
    broadcast_font_size: int = 100

    class Config:
        from_attributes = True


class TournamentDeleteImpact(BaseModel):
    """O que a exclusão do torneio DESTRÓI, com número em cima.

    Todas as FKs que apontam para `tournaments` são ON DELETE CASCADE: apagar
    um torneio leva junto `transactions`, `tournament_players`,
    `prize_allocations`, `tournament_days`, `blinds`, `seat_allocations` e
    `tournament_tables`. Some a venda, o dinheiro recebido e o registro de quem
    pagou — e o caixa da etapa NÃO é estornado (os gatilhos são só de INSERT),
    então o saldo continua apontando dinheiro cuja origem foi apagada e a etapa
    deixa de fechar.

    Este resumo existe para a confirmação dizer "12 entradas, 8 jogadores,
    R$ 2.400" ANTES do clique, em vez do "tem certeza?" genérico de hoje.
    """
    tournament_id: str
    tournament_name: str
    days: int = 0
    # Inscrições que somem da base (linhas de tournament_players).
    players: int = 0
    # Quantas delas pagaram alguma coisa — é o que caracteriza dinheiro em cima.
    paying_players: int = 0
    # Vendas de entrada (buy-in/rebuy/add-on) que ainda valem dinheiro.
    entries: int = 0
    entries_amount: float = 0
    # Premiação já paga: dinheiro que SAIU do caixa.
    prizes: int = 0
    prizes_amount: float = 0
    # Vendas já estornadas: o dinheiro voltou, sobrou o histórico.
    cancelled_entries: int = 0
    # True = tem dinheiro em cima; a exclusão é RECUSADA (409), e o caminho
    # passa a ser cancelar as vendas no Caixa (estorno acerta o caixa) antes.
    blocked: bool = False


class TournamentSummary(BaseModel):
    """Tournament summary with aggregated statistics from all days"""
    id: str
    name: str
    stage_id: Optional[str] = None
    sponsor_id: Optional[str] = None
    sponsor_name: Optional[str] = None  # joined from sponsors table
    has_qualifying: bool = False
    is_satellite: bool = False
    elimination_mode: EliminationMode = EliminationMode.bulk
    status: Optional[str] = "pending"  # A2: campo incluído para exibição de badges no frontend
    total_entries: int = 0  # Somado dos dias. So buy-ins: recompra vai em total_reentries.
    # JOGADOR e REENTRADA sao coisas diferentes, e misturar as duas inflava a
    # contagem do torneio: quem recompra tres vezes continua sendo UMA pessoa na
    # mesa. `total_players` conta gente; `total_reentries` conta so a
    # recompra — add-on compra fichas, nao traz ninguem de volta.
    total_players: int = 0
    total_reentries: int = 0
    total_days: int = 0  # Number of tournament days
    created_by: str
    created_at: datetime
    # Broadcast settings
    broadcast_bg_color: Optional[str] = "#0a0e13"
    broadcast_bg_image_url: Optional[str] = None
    broadcast_display_name: Optional[str] = None
    broadcast_show_logo: bool = True
    broadcast_show_title: bool = True
    broadcast_show_prizepool: bool = True
    broadcast_show_level: bool = True
    broadcast_show_players: bool = True
    broadcast_show_interval: bool = True
    broadcast_show_timer: bool = True
    broadcast_show_blinds: bool = True
    broadcast_show_ante: bool = True
    broadcast_show_next_blind: bool = True
    broadcast_font_size: int = 100

    class Config:
        from_attributes = True
