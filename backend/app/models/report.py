from pydantic import BaseModel
from typing import Dict, List, Optional


class BuyTypeReportRow(BaseModel):
    """Vendas por MEIO de entrada — o cadastrado pelo diretor ("Buy-in",
    "Doble", "Tasa"…), não só a categoria fixa. `name` é o nome gravado na
    venda (o da época); venda antiga sem meio usa o rótulo da categoria."""
    name: str
    category: str = "buy_in"   # 'buy_in' | 'rebuy' | 'addon'
    count: int = 0
    amount: float = 0.0


class PlayerReport(BaseModel):
    player_name: str
    # ENTRADA = buy-in. Recompra e add-on tem campo proprio logo abaixo.
    total_entries: int
    buy_ins: int
    rebuys: int
    addons: int
    total_spent: float
    # Quantas vendas de cada MEIO de entrada ({nome: quantidade}).
    by_buy_type: Dict[str, int] = {}


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
    # Taxas (meio da categoria 'fee'): vendidas como extra, contadas à parte.
    totalFees: int = 0
    playerReports: List[PlayerReport]
    # Vendas do período por MEIO de entrada (o cadastrado pelo diretor).
    byBuyType: List[BuyTypeReportRow] = []


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
    by_buy_type: List[BuyTypeReportRow] = []


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
    total_fees: int = 0             # taxas (Bono Dealer etc.), à parte dos add-ons

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

    # Premiação por eliminação (KO fixo, PKO, Mystery): o pool KO sai do pool
    # líquido; o pago e o pendente vêm dos KOs registrados.
    ko_format: str = "none"
    ko_percentage: float = 0.0
    ko_pool: float = 0.0
    ko_paid: float = 0.0
    ko_pending: float = 0.0

    days: List[TournamentDayReport] = []
    prizes: List[TournamentPrizeRow] = []
    # Vendas do torneio por MEIO de entrada (o cadastrado pelo diretor).
    by_buy_type: List[BuyTypeReportRow] = []
