from pydantic import BaseModel
from typing import List


class PlayerReport(BaseModel):
    player_name: str
    total_entries: int
    buy_ins: int
    rebuys: int
    addons: int
    total_spent: float


class ReportSummary(BaseModel):
    totalRevenue: float
    totalTournaments: int
    totalPlayers: int
    avgBuyIn: float
    totalBuyIns: int
    totalRebuys: int
    totalAddons: int
    playerReports: List[PlayerReport]
