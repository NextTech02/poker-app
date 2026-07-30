from typing import List, Optional
from app.database import supabase
from app.models.player import (
    PlayerCreate,
    PlayerUpdate,
    Player,
    PlayerStats,
    PlayerHistoryEntry,
)


class PlayerService:
    @staticmethod
    def create_player(player_data: PlayerCreate) -> Player:
        """Create a new player"""
        data = player_data.model_dump()
        client_id = data.pop("client_id", None)
        # Offline: usa o id do cliente como PK; idempotente (pré-checa).
        if client_id:
            dup = supabase.table("players").select("*").eq("id", client_id).execute()
            if dup.data:
                return Player(**dup.data[0])
            data["id"] = client_id
        response = supabase.table("players").insert(data).execute()
        return Player(**response.data[0])

    @staticmethod
    def get_players(search: Optional[str] = None) -> List[Player]:
        """Get all players, optionally filtered by search term"""
        query = supabase.table("players").select("*")

        if search:
            # Search by name or nickname
            query = query.or_(f"name.ilike.%{search}%,nickname.ilike.%{search}%")

        response = query.order("name").execute()
        return [Player(**item) for item in response.data]

    @staticmethod
    def get_player(player_id: str) -> Optional[Player]:
        """Get a player by ID"""
        response = supabase.table("players").select("*").eq("id", player_id).execute()

        if response.data:
            return Player(**response.data[0])
        return None

    @staticmethod
    def update_player(player_id: str, player_data: PlayerUpdate) -> Optional[Player]:
        """Update a player"""
        data = player_data.model_dump(exclude_unset=True)

        response = (
            supabase.table("players")
            .update(data)
            .eq("id", player_id)
            .execute()
        )

        if response.data:
            return Player(**response.data[0])
        return None

    @staticmethod
    def delete_player(player_id: str) -> bool:
        """Delete a player"""
        response = supabase.table("players").delete().eq("id", player_id).execute()
        return len(response.data) > 0

    @staticmethod
    def get_player_statistics(player_id: Optional[str] = None) -> List[PlayerStats]:
        """Get player statistics from view"""
        query = supabase.table("player_statistics").select("*")

        if player_id:
            query = query.eq("id", player_id)

        response = query.execute()
        return [PlayerStats(**item) for item in response.data]

    @staticmethod
    def get_player_history(player_id: str) -> List[PlayerHistoryEntry]:
        """Histórico por participação (uma linha por entrada em tournament_players).

        Org-scoped: o backend roda as queries como o usuário (RLS), então só
        retorna torneios da própria organização. Prêmio por entrada vem de
        prize_allocations casado por (torneio + posição final) — a tabela não
        tem tournament_day_id, então o casamento é por posição.
        """
        tp_res = (
            supabase.table("tournament_players")
            .select(
                "id, tournament_id, tournament_day_id, registered_at, status, "
                "buy_in_count, rebuy_count, addon_count, total_spent, final_position, "
                "tournaments(name), "
                "tournament_days!tournament_players_tournament_day_id_fkey(day_name, day_number)"
            )
            .eq("player_id", player_id)
            .order("registered_at", desc=True)
            .execute()
        )
        rows = tp_res.data or []

        # Prêmios do jogador (cash), agrupados por (tournament_id, position).
        prize_res = (
            supabase.table("prize_allocations")
            .select("tournament_id, position, prize_amount, prize_type")
            .eq("player_id", player_id)
            .execute()
        )
        prize_map = {}
        for pa in (prize_res.data or []):
            if pa.get("prize_type") not in (None, "cash"):
                continue
            key = (pa.get("tournament_id"), pa.get("position"))
            prize_map[key] = prize_map.get(key, 0.0) + float(pa.get("prize_amount") or 0)

        history: List[PlayerHistoryEntry] = []
        for r in rows:
            tour = r.get("tournaments") or {}
            day = r.get("tournament_days") or {}
            day_name = day.get("day_name")
            if not day_name and day.get("day_number") is not None:
                day_name = f"Dia {day.get('day_number')}"
            final_pos = r.get("final_position")
            prize = prize_map.get((r.get("tournament_id"), final_pos), 0.0)
            history.append(PlayerHistoryEntry(
                tournament_player_id=r["id"],
                tournament_id=r.get("tournament_id"),
                tournament_name=tour.get("name"),
                tournament_day_id=r.get("tournament_day_id"),
                day_name=day_name,
                registered_at=r.get("registered_at"),
                status=r.get("status"),
                buy_in_count=r.get("buy_in_count") or 0,
                rebuy_count=r.get("rebuy_count") or 0,
                addon_count=r.get("addon_count") or 0,
                total_spent=float(r.get("total_spent") or 0),
                final_position=final_pos,
                prize_won=prize,
            ))
        return history
