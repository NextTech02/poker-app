from typing import List
from app.database import supabase
from app.models.transaction import TransactionCreate, Transaction, TransactionDetail


class TransactionService:
    @staticmethod
    def create_transaction(transaction_data: TransactionCreate, user_id: str) -> TransactionDetail:
        """Create a new transaction"""
        data = transaction_data.model_dump()
        data["created_by"] = user_id

        # Get tournament player ID if exists
        tp_response = supabase.table("tournament_players").select("id").eq("tournament_id", data["tournament_id"]).eq("player_id", data["player_id"]).execute()
        if tp_response.data:
            data["tournament_player_id"] = tp_response.data[0]["id"]

        response = supabase.table("transactions").insert(data).execute()
        trans = response.data[0]

        # Get related info
        tournament = supabase.table("tournaments").select("name").eq("id", data["tournament_id"]).execute()
        player = supabase.table("players").select("name, nickname").eq("id", data["player_id"]).execute()

        tournament_name = tournament.data[0]["name"] if tournament.data else ""
        player_info = player.data[0] if player.data else {}

        return TransactionDetail(
            **trans,
            tournament_name=tournament_name,
            player_name=player_info.get("name", ""),
            player_nickname=player_info.get("nickname")
        )

    @staticmethod
    def get_transactions() -> List[TransactionDetail]:
        """Get all transactions with details"""
        response = (
            supabase.table("transactions")
            .select("*, tournaments(name), players(name, nickname)")
            .order("created_at", desc=True)
            .execute()
        )

        transactions = []
        for item in response.data:
            tournament = item.get("tournaments", {})
            player = item.get("players", {})

            # Remove nested objects
            trans_data = {k: v for k, v in item.items() if k not in ["tournaments", "players"]}

            transactions.append(TransactionDetail(
                **trans_data,
                tournament_name=tournament.get("name", ""),
                player_name=player.get("name", ""),
                player_nickname=player.get("nickname")
            ))

        return transactions

    @staticmethod
    def get_transactions_by_tournament(tournament_id: str) -> List[TransactionDetail]:
        """Get transactions for a specific tournament"""
        response = (
            supabase.table("transactions")
            .select("*, players(name, nickname)")
            .eq("tournament_id", tournament_id)
            .order("created_at", desc=True)
            .execute()
        )

        transactions = []
        for item in response.data:
            player = item.get("players", {})
            trans_data = {k: v for k, v in item.items() if k != "players"}

            transactions.append(TransactionDetail(
                **trans_data,
                tournament_name="",  # Will be filled if needed
                player_name=player.get("name", ""),
                player_nickname=player.get("nickname")
            ))

        return transactions

    @staticmethod
    def get_transactions_by_player(player_id: str) -> List[TransactionDetail]:
        """Get transactions for a specific player"""
        response = (
            supabase.table("transactions")
            .select("*, tournaments(name)")
            .eq("player_id", player_id)
            .order("created_at", desc=True)
            .execute()
        )

        transactions = []
        for item in response.data:
            tournament = item.get("tournaments", {})
            trans_data = {k: v for k, v in item.items() if k != "tournaments"}

            # Get player info
            player = supabase.table("players").select("name, nickname").eq("id", player_id).execute()
            player_info = player.data[0] if player.data else {}

            transactions.append(TransactionDetail(
                **trans_data,
                tournament_name=tournament.get("name", ""),
                player_name=player_info.get("name", ""),
                player_nickname=player_info.get("nickname")
            ))

        return transactions
