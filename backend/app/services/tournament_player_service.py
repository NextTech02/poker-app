from typing import List, Optional
from app.database import supabase
from app.services.tournament_day_service import _chipcount_cache
from app.services.cashbox_service import CashboxService
from app.models.tournament_player import (
    TournamentPlayerCreate,
    TournamentPlayerUpdate,
    TournamentPlayer,
    TournamentPlayerDetail
)


class TournamentPlayerService:
    @staticmethod
    def register_player(registration_data: TournamentPlayerCreate, user_id: str) -> TournamentPlayerDetail:
        """Register a player for a tournament day"""
        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, registration_data.tournament_id)

        # Get tournament details (only name, as other fields are in tournament_days)
        tournament = supabase.table("tournaments").select("name").eq("id", registration_data.tournament_id).execute()
        if not tournament.data:
            raise ValueError("Tournament not found")

        tournament_info = tournament.data[0]

        # tournament_day_id is required for registration
        if not registration_data.tournament_day_id:
            raise ValueError("É necessário selecionar um dia do torneio para inscrição")

        # Get day-specific settings
        day = supabase.table("tournament_days").select("*").eq("id", registration_data.tournament_day_id).execute()
        if not day.data:
            raise ValueError("Tournament day not found")
        day_info = day.data[0]

        # Use day-specific values
        buy_in = float(day_info["buy_in"])
        starting_chips = day_info["starting_chips"]
        max_players = day_info["max_players"]
        registered_players = day_info.get("registered_players", 0)

        # Check if day is full
        if max_players and registered_players >= max_players:
            raise ValueError(f"Este dia do torneio está cheio ({registered_players}/{max_players} jogadores)")

        # Check for duplicate registration in this day
        existing = supabase.table("tournament_players").select("id").eq("tournament_day_id", registration_data.tournament_day_id).eq("player_id", registration_data.player_id).execute()
        if existing.data:
            raise ValueError("Jogador já está registrado neste dia do torneio")

        # Calculate initial amounts
        buy_in_amount = buy_in * registration_data.buy_in_count
        total_chips = starting_chips * registration_data.buy_in_count

        # Create tournament player entry
        data = {
            "tournament_id": registration_data.tournament_id,
            "tournament_day_id": registration_data.tournament_day_id,
            "player_id": registration_data.player_id,
            "buy_in_count": registration_data.buy_in_count,
            "total_buy_in_amount": buy_in_amount,
            "total_chips": total_chips,
            "notes": registration_data.notes,
        }

        response = supabase.table("tournament_players").insert(data).execute()
        tp = response.data[0]

        # Invalidate chipcount cache for this day
        _chipcount_cache.pop(registration_data.tournament_day_id, None)

        # Note: registered_players count is updated automatically by database trigger

        # Handle payment source
        payment_source = registration_data.payment_source or "cash"
        ticket_id = None

        # Ticket payment: free buy-in via satellite ticket
        if payment_source == "ticket":
            ticket_id = registration_data.ticket_id
            # Ticket validation/consumption is handled by SatelliteTicketService.redeem_ticket
            # which calls this method. We just record amount as 0 for cash register.
            buy_in_amount = 0

        elif payment_source in ("credit", "mixed"):
            from app.services.player_credit_service import PlayerCreditService

            available = PlayerCreditService.get_player_available_credit(registration_data.player_id)
            if available <= 0:
                raise ValueError("Jogador não possui crédito disponível")

            credit_result = PlayerCreditService.use_credit(
                player_id=registration_data.player_id,
                amount=buy_in_amount,
                tournament_id=registration_data.tournament_id,
                tournament_day_id=registration_data.tournament_day_id,
                entry_type="buy_in",
                user_id=user_id,
            )

            if credit_result["cash_remaining"] <= 0:
                payment_source = "credit"
            else:
                payment_source = "mixed"

        # Create transaction record
        transaction_data = {
            "tournament_id": registration_data.tournament_id,
            "player_id": registration_data.player_id,
            "tournament_player_id": tp["id"],
            "type": "buy_in",
            "amount": buy_in_amount,
            "payment_source": payment_source,
            "created_by": user_id,
        }
        if ticket_id:
            transaction_data["ticket_id"] = ticket_id
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
    def add_rebuy(tournament_player_id: str, user_id: str, current_blind_level: int = None, payment_source: str = "cash") -> TournamentPlayer:
        """Add a rebuy for a tournament player"""
        # Get tournament player info with tournament_day data
        tp_response = supabase.table("tournament_players").select("*, tournament_days(rebuy_amount, rebuy_chips, rebuy_level_limit, blind_duration, start_time, updated_at, created_at)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        day_info = tp.get("tournament_days", {}) or {}
        rebuy_amount = float(day_info.get("rebuy_amount") or 0)
        rebuy_chips = day_info.get("rebuy_chips") or 10000
        rebuy_level_limit = day_info.get("rebuy_level_limit")

        # Calculate current blind level if not provided
        if current_blind_level is None and rebuy_level_limit is not None:
            from datetime import datetime
            blind_duration = day_info.get("blind_duration") or 15
            start_time_str = day_info.get("start_time") or day_info.get("updated_at") or day_info.get("created_at")
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

        # Invalidate chipcount cache for this day
        _chipcount_cache.pop(tp.get("tournament_day_id"), None)

        # Handle credit payment for rebuy
        actual_payment_source = payment_source
        if payment_source in ("credit", "mixed") and rebuy_amount > 0:
            from app.services.player_credit_service import PlayerCreditService

            available = PlayerCreditService.get_player_available_credit(tp["player_id"])
            if available <= 0:
                raise ValueError("Jogador não possui crédito disponível")

            credit_result = PlayerCreditService.use_credit(
                player_id=tp["player_id"],
                amount=rebuy_amount,
                tournament_id=tp["tournament_id"],
                tournament_day_id=tp.get("tournament_day_id"),
                entry_type="rebuy",
                user_id=user_id,
            )
            actual_payment_source = "credit" if credit_result["cash_remaining"] <= 0 else "mixed"

        # Create transaction
        transaction_data = {
            "tournament_id": tp["tournament_id"],
            "player_id": tp["player_id"],
            "tournament_player_id": tournament_player_id,
            "type": "rebuy",
            "amount": rebuy_amount,
            "payment_source": actual_payment_source,
            "created_by": user_id,
        }
        supabase.table("transactions").insert(transaction_data).execute()

        return TournamentPlayer(**response.data[0])

    @staticmethod
    def add_addon(tournament_player_id: str, user_id: str, payment_source: str = "cash") -> TournamentPlayer:
        """Add an add-on for a tournament player"""
        # Get tournament player info with tournament_day data
        tp_response = supabase.table("tournament_players").select("*, tournament_days(addon_amount, addon_chips)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        day_info = tp.get("tournament_days", {}) or {}
        addon_amount = float(day_info.get("addon_amount") or 0)
        addon_chips = day_info.get("addon_chips") or 10000

        # Update tournament player
        updated_data = {
            "addon_count": tp["addon_count"] + 1,
            "total_addon_amount": float(tp["total_addon_amount"]) + addon_amount,
            "total_chips": tp["total_chips"] + addon_chips,
        }

        response = supabase.table("tournament_players").update(updated_data).eq("id", tournament_player_id).execute()

        # Invalidate chipcount cache for this day
        _chipcount_cache.pop(tp.get("tournament_day_id"), None)

        # Handle credit payment for addon
        actual_payment_source = payment_source
        if payment_source in ("credit", "mixed") and addon_amount > 0:
            from app.services.player_credit_service import PlayerCreditService

            available = PlayerCreditService.get_player_available_credit(tp["player_id"])
            if available <= 0:
                raise ValueError("Jogador não possui crédito disponível")

            credit_result = PlayerCreditService.use_credit(
                player_id=tp["player_id"],
                amount=addon_amount,
                tournament_id=tp["tournament_id"],
                tournament_day_id=tp.get("tournament_day_id"),
                entry_type="addon",
                user_id=user_id,
            )
            actual_payment_source = "credit" if credit_result["cash_remaining"] <= 0 else "mixed"

        # Create transaction
        transaction_data = {
            "tournament_id": tp["tournament_id"],
            "player_id": tp["player_id"],
            "tournament_player_id": tournament_player_id,
            "type": "addon",
            "amount": addon_amount,
            "payment_source": actual_payment_source,
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
    def get_tournament_day_players(tournament_day_id: str) -> List[TournamentPlayerDetail]:
        """Get all players in a tournament day with details"""
        response = (
            supabase.table("tournament_players")
            .select("*, players(name, nickname), tournaments(name)")
            .eq("tournament_day_id", tournament_day_id)
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
