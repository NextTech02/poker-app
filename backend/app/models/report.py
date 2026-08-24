from pydantic import BaseModel
from typing import List, Optional


class PlayerReport(BaseModel):
    player_name: str
    # ENTRADA = buy-in. Recompra e add-on tem campo proprio logo abaixo.
    total_entries: int
    buy_ins: int
    rebuys: int
    addons: int
    total_spent: float


class ReportSummary(BaseModel):
    totalRevenue: float
    totalTournaments: int
    # Numero de ENTRADAS do periodo (buy-ins). O nome ficou de quando "entrada"
    # e "jogador" eram a mesma coisa no sistema; a tela ja rotula "Total de
    # Entradas". Renomear o campo quebraria o contrato com o frontend em uso.
    totalPlayers: int
    avgBuyIn: float
    totalBuyIns: int
    totalRebuys: int
    totalAddons: int
    playerReports: List[PlayerReport]


class TournamentDayReport(BaseModel):
    day_id: str
    day_name: str
    day_type: Optional[str] = None
    status: Optional[str] = None
    buy_in: float = 0.0
    players: int = 0
    buy_ins: int = 0
    rebuys: int = 0
    addons: int = 0
    revenue: float = 0.0


class TournamentPrizeRow(BaseModel):
    position: int
    prize_type: str = "cash"
    prize_amount: float = 0.0
    player_name: Optional[str] = None
    released: bool = False
    paid: bool = False
    visible: bool = True


class TournamentReport(BaseModel):
    tournament_id: str
    tournament_name: str
    sponsor_name: Optional[str] = None
    status: Optional[str] = None
    has_qualifying: bool = False
    is_satellite: bool = False

    # Participation
    total_players: int = 0          # distinct players across all days
    total_entries: int = 0          # so buy-ins
    total_buy_ins: int = 0
    total_rebuys: int = 0
    total_addons: int = 0

    # Financials
    total_revenue: float = 0.0      # buy_in + rebuy + addon amounts
    rake_percentage: float = 0.0
    rake_amount: float = 0.0
    guaranteed_prize: float = 0.0
    available_prize_pool: float = 0.0
    reserved_prize_percentage: float = 0.0
    reserved_purpose: Optional[str] = None
    reserved_amount: float = 0.0    # blocked from payout
    payable_pool: float = 0.0

    # Prize execution
    total_allocated: float = 0.0
    total_distributed: float = 0.0  # sum of paid cash prizes
    pending_release: int = 0        # allocations not yet released
    vagas_count: int = 0            # number of 'vaga' tiers
    vagas_generated: int = 0        # vaga tickets already generated

    days: List[TournamentDayReport] = []
    prizes: List[TournamentPrizeRow] = []
