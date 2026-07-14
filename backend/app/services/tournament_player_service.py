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
    def _get_buy_type(buy_type_id: Optional[str]) -> Optional[dict]:
        """Busca um tipo de buy (por etapa) — define valor e rake da transação."""
        if not buy_type_id:
            return None
        bt = supabase.table("buy_types").select("amount, rake_percentage").eq("id", buy_type_id).execute()
        return bt.data[0] if bt.data else None

    @staticmethod
    def _detail_from_tp(tp: dict, tournament_name: str = "") -> TournamentPlayerDetail:
        player = supabase.table("players").select("name, nickname").eq("id", tp["player_id"]).execute()
        pinfo = player.data[0] if player.data else {}
        if not tournament_name:
            tn = supabase.table("tournaments").select("name").eq("id", tp["tournament_id"]).execute()
            tournament_name = tn.data[0]["name"] if tn.data else ""
        return TournamentPlayerDetail(
            **tp,
            player_name=pinfo.get("name", ""),
            player_nickname=pinfo.get("nickname"),
            tournament_name=tournament_name,
        )

    @staticmethod
    def register_player(registration_data: TournamentPlayerCreate, user_id: str) -> TournamentPlayerDetail:
        """Register a player for a tournament day"""
        client_id = registration_data.client_id
        client_mutation_id = registration_data.client_mutation_id

        # Idempotência (replay offline): se este tournament_player já existe (mesmo
        # client_id), devolve-o sem re-executar — sem validar cashbox/duplicidade.
        if client_id:
            dup = supabase.table("tournament_players").select("*").eq("client_id", client_id).execute()
            if dup.data:
                return TournamentPlayerService._detail_from_tp(dup.data[0])

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

        # O VALOR da entrada vem sempre da configuração do DIA (fonte única).
        # O tipo de buy (por etapa), quando informado, define apenas o RAKE;
        # sem tipo, usa o rake do dia.
        buy_type = TournamentPlayerService._get_buy_type(registration_data.buy_type_id)
        rake_pct = float(buy_type["rake_percentage"]) if buy_type else float(day_info.get("rake_percentage") or 0)

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
        # Offline: usa o id gerado no cliente como PK (para o rebuy/addon offline
        # referenciarem o jogador) e marca client_id para idempotência.
        if client_id:
            data["id"] = client_id
            data["client_id"] = client_id

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
            "payment_method": registration_data.payment_method or "cash",
            "buy_type_id": registration_data.buy_type_id,
            "rake_percentage": rake_pct,
            "rake_amount": round(buy_in_amount * rake_pct / 100, 2),
            "created_by": user_id,
        }
        if ticket_id:
            transaction_data["ticket_id"] = ticket_id
        if client_mutation_id:
            transaction_data["client_id"] = client_mutation_id
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
    def add_rebuy(tournament_player_id: str, user_id: str, current_blind_level: int = None, payment_source: str = "cash", payment_method: str = "cash", buy_type_id: str = None, client_mutation_id: str = None, skip_level_gate: bool = False) -> TournamentPlayer:
        """Add a rebuy for a tournament player"""
        # Get tournament player info with tournament_day data
        tp_response = supabase.table("tournament_players").select("*, tournament_days!tournament_players_tournament_day_id_fkey(rebuy_amount, rebuy_chips, rebuy_level_limit, rake_percentage, blind_duration, start_time, updated_at, created_at)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Idempotência (replay offline): se a transação deste rebuy já existe
        # (mesmo client_mutation_id), não re-incrementa contadores — devolve o tp atual.
        if client_mutation_id:
            dup = supabase.table("transactions").select("id").eq("client_id", client_mutation_id).execute()
            if dup.data:
                return TournamentPlayer(**{k: v for k, v in tp.items() if k != "tournament_days"})

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        day_info = tp.get("tournament_days", {}) or {}
        # Valor sempre do dia; o tipo de buy define apenas o rake (se informado).
        buy_type = TournamentPlayerService._get_buy_type(buy_type_id)
        rebuy_amount = float(day_info.get("rebuy_amount") or 0)
        rake_pct = float(buy_type["rake_percentage"]) if buy_type else float(day_info.get("rake_percentage") or 0)
        rebuy_chips = day_info.get("rebuy_chips") or 10000
        rebuy_level_limit = day_info.get("rebuy_level_limit")

        # Calculate current blind level if not provided. No replay OFFLINE
        # (skip_level_gate=True) NÃO recomputamos pelo tempo de agora — o operador fez
        # o rebuy em tempo real quando ainda era permitido; recomputar no sync (mais
        # tarde) rejeitaria injustamente.
        if not skip_level_gate and current_blind_level is None and rebuy_level_limit is not None:
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
        if not skip_level_gate and rebuy_level_limit is not None and current_blind_level is not None:
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
            "payment_method": payment_method or "cash",
            "buy_type_id": buy_type_id,
            "rake_percentage": rake_pct,
            "rake_amount": round(rebuy_amount * rake_pct / 100, 2),
            "created_by": user_id,
        }
        if client_mutation_id:
            transaction_data["client_id"] = client_mutation_id
        supabase.table("transactions").insert(transaction_data).execute()

        return TournamentPlayer(**response.data[0])

    @staticmethod
    def add_addon(tournament_player_id: str, user_id: str, payment_source: str = "cash", payment_method: str = "cash", buy_type_id: str = None, client_mutation_id: str = None) -> TournamentPlayer:
        """Add an add-on for a tournament player"""
        # Get tournament player info with tournament_day data
        tp_response = supabase.table("tournament_players").select("*, tournament_days!tournament_players_tournament_day_id_fkey(addon_amount, addon_chips, rake_percentage)").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Idempotência (replay offline): addon já aplicado? devolve o tp atual.
        if client_mutation_id:
            dup = supabase.table("transactions").select("id").eq("client_id", client_mutation_id).execute()
            if dup.data:
                return TournamentPlayer(**{k: v for k, v in tp.items() if k != "tournament_days"})

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        day_info = tp.get("tournament_days", {}) or {}
        # Valor sempre do dia; o tipo de buy define apenas o rake (se informado).
        buy_type = TournamentPlayerService._get_buy_type(buy_type_id)
        addon_amount = float(day_info.get("addon_amount") or 0)
        rake_pct = float(buy_type["rake_percentage"]) if buy_type else float(day_info.get("rake_percentage") or 0)
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
            "payment_method": payment_method or "cash",
            "buy_type_id": buy_type_id,
            "rake_percentage": rake_pct,
            "rake_amount": round(addon_amount * rake_pct / 100, 2),
            "created_by": user_id,
        }
        if client_mutation_id:
            transaction_data["client_id"] = client_mutation_id
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
    def eliminate_player(tournament_player_id: str, user_id: str, idempotent: bool = False) -> TournamentPlayer:
        """Eliminate a player from the tournament (mark as eliminated)"""
        from datetime import datetime
        from app.services.ranking_service import RankingService

        # Get tournament player info
        tp_response = supabase.table("tournament_players").select("*").eq("id", tournament_player_id).execute()
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Check if already eliminated. No replay offline (idempotent=True) devolve o
        # tp sem erro; online (clique duplo) mantém o aviso ao operador.
        if tp.get("status") == "eliminated":
            if idempotent:
                return TournamentPlayer(**tp)
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
