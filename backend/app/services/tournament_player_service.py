from typing import List, Optional
from app.database import supabase
from app.models.tournament_player import (
    TournamentPlayerCreate,
    TournamentPlayerUpdate,
    TournamentPlayer,
    TournamentPlayerDetail
)


class TournamentPlayerService:
    @staticmethod
    def register_player(registration_data: TournamentPlayerCreate, user_id: str) -> TournamentPlayerDetail:
        """Register a player for a tournament"""
        # Get tournament details
        tournament = supabase.table("tournaments").select("name, buy_in, starting_chips, max_players, registered_players").eq("id", registration_data.tournament_id).execute()
        if not tournament.data:
            raise ValueError("Tournament not found")

        tournament_info = tournament.data[0]

        # VALIDATION: Check if tournament is full
        current_players = tournament_info.get("registered_players", 0)
        max_players = tournament_info.get("max_players")

        if current_players >= max_players:
            raise ValueError(f"Tournament is full ({current_players}/{max_players} players)")

        # VALIDATION: Check for duplicate registration
        existing = supabase.table("tournament_players").select("id").eq("tournament_id", registration_data.tournament_id).eq("player_id", registration_data.player_id).execute()
        if existing.data:
            raise ValueError("Player is already registered for this tournament")

        # Calculate initial amounts
        buy_in_amount = float(tournament_info["buy_in"]) * registration_data.buy_in_count
        starting_chips = tournament_info["starting_chips"] * registration_data.buy_in_count

        # Create tournament player entry
        data = {
            "tournament_id": registration_data.tournament_id,
            "player_id": registration_data.player_id,
            "buy_in_count": registration_data.buy_in_count,
            "total_buy_in_amount": buy_in_amount,
            "total_chips": starting_chips,
            "notes": registration_data.notes,
        }

        response = supabase.table("tournament_players").insert(data).execute()
        tp = response.data[0]

        # Create transaction record
        transaction_data = {
            "tournament_id": registration_data.tournament_id,
            "player_id": registration_data.player_id,
            "tournament_player_id": tp["id"],
            "type": "buy_in",
            "amount": buy_in_amount,
            "created_by": user_id,
        }
        supabase.table("transactions").insert(transaction_data).execute()

        # Get player info
        player = supabase.table("players").select("name, nickname").eq("id", registration_data.player_id).execute()
        player_info = player.data[0] if player.data else {}

        # Return detailed info
        return TournamentPlayerDetail(
            **tp,
            player_name=player_info.get("name", ""),
            player_nickname=player_info.get("nickname"),
            tournament_name=tournament_info["name"]
        )

    @staticmethod
    def add_rebuy(tournament_player_id: str, user_id: str, current_blind_level: int = None) -> TournamentPlayer:
        """Add a rebuy for a tournament player"""
        # Get tournament player info
        tp_response = supabase.table("tournament_players").select("*, tournaments(rebuy_amount, rebuy_chips, rebuy_level_limit, blind_duration, start_time, updated_at, created_at)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]
        tournament = tp.get("tournaments", {})
        rebuy_amount = float(tournament.get("rebuy_amount", 0))
        rebuy_chips = tournament.get("rebuy_chips", 10000)
        rebuy_level_limit = tournament.get("rebuy_level_limit")

        # Calculate current blind level if not provided
        if current_blind_level is None and rebuy_level_limit is not None:
            from datetime import datetime
            blind_duration = tournament.get("blind_duration", 15)
            start_time_str = tournament.get("start_time") or tournament.get("updated_at") or tournament.get("created_at")
            if start_time_str:
                start_time = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
                now = datetime.now(start_time.tzinfo)
                elapsed_seconds = (now - start_time).total_seconds()
                blind_duration_seconds = blind_duration * 60
                current_blind_level = int(elapsed_seconds // blind_duration_seconds) + 1

        # Check if rebuys are still allowed based on blind level
        if rebuy_level_limit is not None and current_blind_level is not None:
            if current_blind_level > rebuy_level_limit:
                raise ValueError(f"Rebuys não são mais permitidos. Limite: nível {rebuy_level_limit}, Atual: nível {current_blind_level}")

        # Update tournament player - if eliminated, reactivate them
        updated_data = {
            "rebuy_count": tp["rebuy_count"] + 1,
            "total_rebuy_amount": float(tp["total_rebuy_amount"]) + rebuy_amount,
            "total_chips": tp["total_chips"] + rebuy_chips,
            "status": "active",  # Reactivate player if they were eliminated
        }

        response = supabase.table("tournament_players").update(updated_data).eq("id", tournament_player_id).execute()

        # Create transaction
        transaction_data = {
            "tournament_id": tp["tournament_id"],
            "player_id": tp["player_id"],
            "tournament_player_id": tournament_player_id,
            "type": "rebuy",
            "amount": rebuy_amount,
            "created_by": user_id,
        }
        supabase.table("transactions").insert(transaction_data).execute()

        return TournamentPlayer(**response.data[0])

    @staticmethod
    def add_addon(tournament_player_id: str, user_id: str) -> TournamentPlayer:
        """Add an add-on for a tournament player"""
        # Get tournament player info
        tp_response = supabase.table("tournament_players").select("*, tournaments(addon_amount, addon_chips)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]
        tournament = tp.get("tournaments", {})
        addon_amount = float(tournament.get("addon_amount", 0))
        addon_chips = tournament.get("addon_chips", 10000)

        # Update tournament player
        updated_data = {
            "addon_count": tp["addon_count"] + 1,
            "total_addon_amount": float(tp["total_addon_amount"]) + addon_amount,
            "total_chips": tp["total_chips"] + addon_chips,
        }

        response = supabase.table("tournament_players").update(updated_data).eq("id", tournament_player_id).execute()

        # Create transaction
        transaction_data = {
            "tournament_id": tp["tournament_id"],
            "player_id": tp["player_id"],
            "tournament_player_id": tournament_player_id,
            "type": "addon",
            "amount": addon_amount,
            "created_by": user_id,
        }
        supabase.table("transactions").insert(transaction_data).execute()

        return TournamentPlayer(**response.data[0])

    @staticmethod
    def get_tournament_players(tournament_id: str) -> List[TournamentPlayerDetail]:
        """Get all players in a tournament with details"""
        response = (
            supabase.table("tournament_players")
            .select("*, players(name, nickname), tournaments(name)")
            .eq("tournament_id", tournament_id)
            .order("registered_at")
            .execute()
        )

        result = []
        for item in response.data:
            player = item.get("players", {})
            tournament = item.get("tournaments", {})

            # Remove nested objects
            clean_item = {k: v for k, v in item.items() if k not in ["players", "tournaments"]}

            result.append(TournamentPlayerDetail(
                **clean_item,
                player_name=player.get("name", ""),
                player_nickname=player.get("nickname"),
                tournament_name=tournament.get("name", "")
            ))

        return result

    @staticmethod
    def update_tournament_player(tournament_player_id: str, update_data: TournamentPlayerUpdate) -> Optional[TournamentPlayer]:
        """Update tournament player (position, prize, status, etc.)"""
        data = update_data.model_dump(exclude_unset=True)

        response = (
            supabase.table("tournament_players")
            .update(data)
            .eq("id", tournament_player_id)
            .execute()
        )

        if response.data:
            return TournamentPlayer(**response.data[0])
        return None

    @staticmethod
    def eliminate_player(tournament_player_id: str, user_id: str) -> TournamentPlayer:
        """Eliminate a player from the tournament (mark as eliminated)"""
        from datetime import datetime
        from app.services.ranking_service import RankingService

        # Get tournament player info
        tp_response = supabase.table("tournament_players").select("*").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Check if already eliminated
        if tp.get("status") == "eliminated":
            raise ValueError("Player is already eliminated")

        # Update tournament player status to eliminated with timestamp
        updated_data = {
            "status": "eliminated",
            "eliminated_at": datetime.now().isoformat(),
        }

        response = supabase.table("tournament_players").update(updated_data).eq("id", tournament_player_id).execute()

        # Recalculate rankings for this tournament
        tournament_id = tp["tournament_id"]
        try:
            RankingService.calculate_rankings(tournament_id)
        except Exception as e:
            print(f"Error recalculating rankings after elimination: {str(e)}")
            # Don't fail the elimination if ranking calculation fails

        return TournamentPlayer(**response.data[0])
