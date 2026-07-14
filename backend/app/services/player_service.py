from typing import List, Optional
from app.database import supabase
from app.models.player import PlayerCreate, PlayerUpdate, Player, PlayerStats


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
