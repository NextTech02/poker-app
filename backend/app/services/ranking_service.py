from typing import List, Dict, Optional
from datetime import datetime
from app.database import supabase


class RankingService:
    """Service for managing tournament rankings based on elimination order"""

    @staticmethod
    def calculate_rankings(tournament_id: str) -> List[Dict]:
        """
        Calculate rankings for all eliminated players in a tournament.
        Players are ranked in reverse order of elimination:
        - Last player eliminated gets position 1 (or 2 if there's a winner)
        - First player eliminated gets the highest position number
        """
        try:
            # Get all eliminated players ordered by elimination time (oldest first)
            response = supabase.table("tournament_players")\
                .select("id, player_id, eliminated_at, status, players(name)")\
                .eq("tournament_id", tournament_id)\
                .eq("status", "eliminated")\
                .order("eliminated_at", desc=False)\
                .execute()

            eliminated_players = response.data

            if not eliminated_players:
                return []

            # Assign positions in reverse order
            # First eliminated = highest position number
            # Last eliminated = lowest position number (but not 1st, that's for winner)
            total_eliminated = len(eliminated_players)

            updated_rankings = []
            for index, player in enumerate(eliminated_players):
                # Position calculation: first eliminated gets total_eliminated + 1
                # Last eliminated gets 2 (1st place is reserved for winner)
                position = total_eliminated - index + 1

                # Update the player's position
                update_response = supabase.table("tournament_players")\
                    .update({"final_position": position})\
                    .eq("id", player["id"])\
                    .execute()

                updated_rankings.append({
                    "player_id": player["player_id"],
                    "player_name": player["players"]["name"],
                    "position": position,
                    "eliminated_at": player["eliminated_at"]
                })

            return updated_rankings

        except Exception as e:
            print(f"Error calculating rankings: {str(e)}")
            raise

    @staticmethod
    def get_tournament_rankings(tournament_id: str) -> List[Dict]:
        """Get current rankings for a tournament"""
        try:
            response = supabase.table("tournament_players")\
                .select("id, final_position, prize_won, eliminated_at, status, players(id, name, nickname)")\
                .eq("tournament_id", tournament_id)\
                .not_.is_("final_position", "null")\
                .order("final_position", desc=False)\
                .execute()

            rankings = []
            for player in response.data:
                rankings.append({
                    "position": player["final_position"],
                    "player_id": player["players"]["id"],
                    "player_name": player["players"]["name"],
                    "player_nickname": player["players"].get("nickname"),
                    "prize_won": float(player.get("prize_won", 0)),
                    "eliminated_at": player.get("eliminated_at"),
                    "status": player["status"]
                })

            return rankings

        except Exception as e:
            print(f"Error getting rankings: {str(e)}")
            raise

    @staticmethod
    def remove_from_ranking(tournament_player_id: str) -> bool:
        """
        Remove a player from ranking (set position to null).
        Used when a player does rebuy after elimination.
        """
        try:
            # Get the player's current position before removing
            player_response = supabase.table("tournament_players")\
                .select("tournament_id, final_position")\
                .eq("id", tournament_player_id)\
                .single()\
                .execute()

            if not player_response.data or not player_response.data.get("final_position"):
                return False

            tournament_id = player_response.data["tournament_id"]
            removed_position = player_response.data["final_position"]

            # Remove the player's position
            supabase.table("tournament_players")\
                .update({
                    "final_position": None,
                    "status": "active",
                    "eliminated_at": None
                })\
                .eq("id", tournament_player_id)\
                .execute()

            # Recalculate rankings for remaining eliminated players
            RankingService.calculate_rankings(tournament_id)

            return True

        except Exception as e:
            print(f"Error removing from ranking: {str(e)}")
            raise

    @staticmethod
    def set_winner(tournament_id: str, player_id: str, prize_amount: float = 0) -> Dict:
        """Set the tournament winner (1st place)"""
        try:
            # Find the tournament player record
            response = supabase.table("tournament_players")\
                .select("id")\
                .eq("tournament_id", tournament_id)\
                .eq("player_id", player_id)\
                .single()\
                .execute()

            if not response.data:
                raise ValueError("Player not found in tournament")

            # Update to winner status
            update_response = supabase.table("tournament_players")\
                .update({
                    "status": "winner",
                    "final_position": 1,
                    "prize_won": prize_amount
                })\
                .eq("id", response.data["id"])\
                .execute()

            return update_response.data

        except Exception as e:
            print(f"Error setting winner: {str(e)}")
            raise
