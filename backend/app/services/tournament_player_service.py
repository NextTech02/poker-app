from typing import List, Optional
from app.database import supabase
from app.services.tournament_day_service import _chipcount_cache
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService, seguir_sem_a_trava
from app.utils.erros import ErroDeNegocio
from app.models.tournament_player import (
    TournamentPlayerCreate,
    TournamentPlayerUpdate,
    TournamentPlayer,
    TournamentPlayerDetail
)

_EMBED_DO_DIA = "tournament_days!tournament_players_tournament_day_id_fkey"
# Colunas da trava lidas JUNTO do dia. Recompra e add-on já leem o dia embutido
# no inscrito; trazer a trava no mesmo join poupa UMA ida ao banco em cada uma —
# e recompra é o que mais roda no balcão numa noite de torneio.
_COLUNAS_DA_TRAVA = "sales_blocked, sales_blocked_reason"


def _ler_inscrito_com_o_dia(tournament_player_id: str, colunas_do_dia: str):
    """Lê o inscrito com o dia embutido, incluindo as colunas da trava.

    Enquanto a migração da trava não roda naquele banco (o deploy não é atômico
    com ela), citar as colunas faria a consulta falhar e a recompra pararia de
    funcionar — por isso a leitura é REFEITA sem elas.

    A repetição é para QUALQUER falha, de propósito: é um SELECT, repetir não
    cobra nada de ninguém, e se a segunda leitura passar a venda segue sem a
    trava do dia — a mesma escolha de `seguir_sem_a_trava`. Filtrar pelo texto
    do erro só criaria um jeito novo de a recompra parar no balcão.
    """
    def _buscar(colunas: str, com_trava: bool):
        # A ETAPA vem embutida junto de propósito: sem isso, toda venda fazia uma
        # segunda ida ao banco só para saber se a etapa está bloqueada. Nesta
        # instalação o banco fica em outra região e cada ida custa ~270ms — é a
        # consulta mais cara que dá para simplesmente não fazer.
        etapa = ", tournaments(stage_id, stages(sales_blocked, sales_blocked_reason))" if com_trava else ""
        return (
            supabase.table("tournament_players")
            .select(f"*, {_EMBED_DO_DIA}({colunas}){etapa}")
            .eq("id", tournament_player_id)
            .execute()
        )

    try:
        return _buscar(f"{colunas_do_dia}, {_COLUNAS_DA_TRAVA}", com_trava=True)
    except Exception as exc:
        # Banco sem a migração da trava: as colunas não existem e a consulta
        # falha. Refaz sem elas — e sem o embed da etapa, que cita as mesmas
        # colunas. A venda segue sem a trava, que é a escolha já documentada em
        # `seguir_sem_a_trava`: parar o balcão seria pior.
        seguir_sem_a_trava(exc, f"dia embutido do inscrito {tournament_player_id}")
        return _buscar(colunas_do_dia, com_trava=False)


class TournamentPlayerService:
    @staticmethod
    def _get_buy_type(
        buy_type_id: Optional[str],
        tournament_id: Optional[str] = None,
        permitir_inativo: bool = False,
    ) -> Optional[dict]:
        """Busca o meio de entrada escolhido — ele diz VALOR, RAKE e FICHAS.

        O nome vem junto porque a venda o congela em `transactions.buy_type_name`:
        a FK é ON DELETE SET NULL, então apagar o tipo depois deixaria o recibo
        sem dizer o que a pessoa comprou.

        Confere o DONO: a lista é por torneio, e um id de outro torneio cobraria
        o preço de outro evento. Meio DESATIVADO também é recusado — ele saiu do
        Caixa por decisão do clube. A exceção é o replay da fila offline
        (`permitir_inativo`): a venda aconteceu no balcão ENQUANTO ele estava
        ativo, e recusar ali só criaria um conflito sem solução com o dinheiro
        já na gaveta.

        Id que não existe mais continua devolvendo None (a venda cai na reserva
        do dia): o replay de uma venda antiga não pode parar por um tipo apagado.
        """
        if not buy_type_id:
            return None
        bt = (
            supabase.table("buy_types")
            .select("tournament_id, name, category, amount, rake_percentage, chips, active")
            .eq("id", buy_type_id)
            .execute()
        )
        if not bt.data:
            return None
        tipo = bt.data[0]
        dono = tipo.get("tournament_id")
        if dono and tournament_id and dono != tournament_id:
            raise ErroDeNegocio(
                "meio_de_entrada_de_outro_torneio",
                "O meio de entrada escolhido não pertence a este torneio.",
            )
        if tipo.get("active") is False and not permitir_inativo:
            raise ErroDeNegocio(
                "meio_de_entrada_inativo",
                "Este meio de entrada foi desativado. Escolha outro.",
            )
        return tipo

    @staticmethod
    def _e_legado(buy_type: Optional[dict]) -> bool:
        """Tipo LEGADO: o da ETAPA, de quando ele só servia para dizer o rake.

        Reconhece-se por não pertencer a nenhum TORNEIO — e NÃO por ter `chips`
        nulo, que era como este código tentava distingui-lo. A coluna nasceu
        `NOT NULL DEFAULT 0`, então todo tipo legado ficou com `chips = 0` e
        nenhum com nulo: a distinção nunca acontecia, e vender por um deles
        entregaria ZERO fichas e cobraria ZERO (quatro têm `amount = 0`, porque
        naquele desenho o valor vinha sempre do dia).

        As linhas da época em que a lista era por DIA ganharam `tournament_id`
        na migração para o torneio; só as da etapa ficaram sem. Isso chega em
        produção pelo replay da fila offline: um aparelho que ficou sem rede
        com vendas apontando para tipos da etapa sincroniza depois do deploy.
        Para eles, o certo é o comportamento de antes — rake do tipo, valor e
        fichas do dia.
        """
        return bool(buy_type) and not buy_type.get("tournament_id")

    @staticmethod
    def _fichas_do_tipo(buy_type: Optional[dict], fichas_do_dia) -> int:
        """Fichas que a venda entrega: as do TIPO, ou as do dia quando ele é legado."""
        if not buy_type or TournamentPlayerService._e_legado(buy_type):
            return int(fichas_do_dia or 0)
        fichas = buy_type.get("chips")
        if fichas is None:
            return int(fichas_do_dia or 0)
        return int(fichas)

    @staticmethod
    def _valor_e_rake(buy_type: Optional[dict], valor_do_dia, rake_do_dia) -> tuple:
        """(valor, rake) da venda.

        Tipo do dia manda nos dois. Tipo legado manda só no rake — era assim que
        ele funcionava, e mudar isso agora cobraria o valor errado das vendas que
        vierem da fila offline de antes da mudança. Sem tipo, tudo vem do dia.
        """
        if buy_type and not TournamentPlayerService._e_legado(buy_type):
            return float(buy_type.get("amount") or 0), float(buy_type.get("rake_percentage") or 0)
        rake = float((buy_type or {}).get("rake_percentage") or rake_do_dia or 0)
        return float(valor_do_dia or 0), rake

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
    def _inscricao_ja_registrada(client_id: Optional[str]) -> Optional[TournamentPlayerDetail]:
        """Replay offline: se este tournament_player já existe (mesmo client_id),
        devolve-o — sem re-executar validação de cashbox/duplicidade."""
        if not client_id:
            return None
        dup = supabase.table("tournament_players").select("*").eq("client_id", client_id).execute()
        if not dup.data:
            return None
        return TournamentPlayerService._detail_from_tp(dup.data[0])

    @staticmethod
    def _carregar_dia_da_inscricao(registration_data: TournamentPlayerCreate, skip_sales_block: bool) -> dict:
        """Lê o dia da inscrição e recusa a venda se o diretor tiver bloqueado."""
        # tournament_day_id is required for registration
        if not registration_data.tournament_day_id:
            raise ValueError("É necessário selecionar um dia do torneio para inscrição")

        # Get day-specific settings
        day = supabase.table("tournament_days").select("*").eq("id", registration_data.tournament_day_id).execute()
        if not day.data:
            raise ValueError("Tournament day not found")
        day_info = day.data[0]

        # Vendas bloqueadas pelo diretor? O dia já está em mãos, então só a
        # etapa custa uma consulta a mais.
        if not skip_sales_block:
            SalesBlockService.assert_sales_allowed(
                registration_data.tournament_id,
                registration_data.tournament_day_id,
                day_row=day_info,
            )

        return day_info

    @staticmethod
    def _conferir_lotacao_e_duplicidade(registration_data: TournamentPlayerCreate, day_info: dict) -> None:
        """Dia cheio ou jogador já inscrito nele barram a inscrição."""
        max_players = day_info["max_players"]
        registered_players = day_info.get("registered_players", 0)

        # Check if day is full
        if max_players and registered_players >= max_players:
            raise ValueError(f"Este dia do torneio está cheio ({registered_players}/{max_players} jogadores)")

        # Check for duplicate registration in this day
        existing = supabase.table("tournament_players").select("id").eq("tournament_day_id", registration_data.tournament_day_id).eq("player_id", registration_data.player_id).execute()
        if existing.data:
            raise ValueError("Jogador já está registrado neste dia do torneio")

    @staticmethod
    def _aplicar_forma_de_pagamento(registration_data: TournamentPlayerCreate, buy_in_amount: float, user_id: str):
        """Consome o pagamento da entrada e devolve (origem, ticket, valor cobrado)."""
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

        return payment_source, ticket_id, buy_in_amount

    @staticmethod
    def _venda_ja_registrada(tp: dict, client_mutation_id: Optional[str], quantity: int = 1) -> Optional[TournamentPlayer]:
        """Replay offline: se a transação desta venda já existe (mesmo
        client_mutation_id), não re-incrementa contadores — devolve o tp atual.

        Numa recompra em lote as linhas são gravadas como `cmid:0`, `cmid:1`...
        Procurar só por `cmid` não acharia nenhuma e o replay duplicaria TODAS —
        por isso o lote procura pela primeira linha da série."""
        if not client_mutation_id:
            return None
        procurado = client_mutation_id if quantity == 1 else f"{client_mutation_id}:0"
        dup = supabase.table("transactions").select("id").eq("client_id", procurado).execute()
        if not dup.data:
            return None
        return TournamentPlayer(**{k: v for k, v in tp.items() if k != "tournament_days"})

    @staticmethod
    def _pagar_com_credito(tp: dict, valor: float, tipo_de_entrada: str, payment_source: str, user_id: str) -> str:
        """Consome o crédito do jogador e devolve a origem final do pagamento.

        "credit" quando o crédito cobriu tudo, "mixed" quando ainda sobrou
        dinheiro a receber no balcão.
        """
        if payment_source in ("credit", "mixed") and valor > 0:
            from app.services.player_credit_service import PlayerCreditService

            available = PlayerCreditService.get_player_available_credit(tp["player_id"])
            if available <= 0:
                raise ValueError("Jogador não possui crédito disponível")

            credit_result = PlayerCreditService.use_credit(
                player_id=tp["player_id"],
                amount=valor,
                tournament_id=tp["tournament_id"],
                tournament_day_id=tp.get("tournament_day_id"),
                entry_type=tipo_de_entrada,
                user_id=user_id,
            )
            return "credit" if credit_result["cash_remaining"] <= 0 else "mixed"
        return payment_source

    @staticmethod
    def _nivel_de_blind_pelo_relogio(day_info: dict) -> Optional[int]:
        """Em que nível o dia está agora, contado do início pelo tempo de blind."""
        from datetime import datetime
        blind_duration = day_info.get("blind_duration") or 15
        start_time_str = day_info.get("start_time") or day_info.get("updated_at") or day_info.get("created_at")
        if not start_time_str:
            return None
        start_time = datetime.fromisoformat(start_time_str.replace('Z', '+00:00'))
        now = datetime.now(start_time.tzinfo)
        elapsed_seconds = (now - start_time).total_seconds()
        blind_duration_seconds = blind_duration * 60
        return int(elapsed_seconds // blind_duration_seconds) + 1

    @staticmethod
    def _recusar_rebuy_fora_do_nivel(day_info: dict, current_blind_level: Optional[int], skip_level_gate: bool) -> None:
        """Rebuy só vale até o nível-limite do dia; sem limite configurado, vale sempre.

        No replay OFFLINE (skip_level_gate=True) NÃO recomputamos pelo tempo de agora — o
        operador fez o rebuy em tempo real quando ainda era permitido; recomputar no sync
        (mais tarde) rejeitaria injustamente.
        """
        if skip_level_gate:
            return
        rebuy_level_limit = day_info.get("rebuy_level_limit")
        if rebuy_level_limit is None:
            return
        if current_blind_level is None:
            current_blind_level = TournamentPlayerService._nivel_de_blind_pelo_relogio(day_info)
        if current_blind_level is not None and current_blind_level > rebuy_level_limit:
            raise ValueError(f"Rebuys não são mais permitidos. Limite: nível {rebuy_level_limit}, Atual: nível {current_blind_level}")

    @staticmethod
    def register_player(registration_data: TournamentPlayerCreate, user_id: str, skip_sales_block: bool = False, permitir_meio_inativo: bool = False) -> TournamentPlayerDetail:
        """Register a player for a tournament day"""
        client_id = registration_data.client_id
        client_mutation_id = registration_data.client_mutation_id

        # Idempotência (replay offline): se este tournament_player já existe (mesmo
        # client_id), devolve-o sem re-executar — sem validar cashbox/duplicidade.
        ja_inscrito = TournamentPlayerService._inscricao_ja_registrada(client_id)
        if ja_inscrito is not None:
            return ja_inscrito

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, registration_data.tournament_id)

        # Get tournament details (only name, as other fields are in tournament_days)
        tournament = supabase.table("tournaments").select("name").eq("id", registration_data.tournament_id).execute()
        if not tournament.data:
            raise ValueError("Tournament not found")

        tournament_info = tournament.data[0]

        day_info = TournamentPlayerService._carregar_dia_da_inscricao(registration_data, skip_sales_block)

        TournamentPlayerService._conferir_lotacao_e_duplicidade(registration_data, day_info)

        # O MEIO DE ENTRADA manda em tudo: valor, rake e fichas. É ele que faz
        # um "buy-in duplo" ser uma venda própria, e não o buy-in simples vezes
        # dois — os campos do dia não têm onde guardar essa diferença.
        #
        # SEM tipo escolhido, nada muda: valor, rake e fichas continuam vindo do
        # dia. É o torneio que ainda não cadastrou meios de entrada, e ele não
        # pode parar de vender por causa disso.
        buy_type = TournamentPlayerService._get_buy_type(
            registration_data.buy_type_id,
            registration_data.tournament_id,
            permitir_inativo=permitir_meio_inativo,
        )
        buy_in, rake_pct = TournamentPlayerService._valor_e_rake(
            buy_type, day_info["buy_in"], day_info.get("rake_percentage")
        )
        starting_chips = TournamentPlayerService._fichas_do_tipo(
            buy_type, day_info.get("starting_chips")
        )

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
        payment_source, ticket_id, buy_in_amount = \
            TournamentPlayerService._aplicar_forma_de_pagamento(registration_data, buy_in_amount, user_id)

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
            "buy_type_name": (buy_type or {}).get("name"),
            "rake_percentage": rake_pct,
            "rake_amount": round(buy_in_amount * rake_pct / 100, 2),
            # Retrato do momento, como já é feito com o rake: editar o tipo
            # depois (10.000 -> 15.000 fichas) não pode fazer o ESTORNO desta
            # venda devolver fichas que ela nunca entregou.
            "chips": total_chips,
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
    def add_rebuy(tournament_player_id: str, user_id: str, current_blind_level: int = None, payment_source: str = "cash", payment_method: str = "cash", buy_type_id: str = None, client_mutation_id: str = None, skip_level_gate: bool = False, skip_sales_block: bool = False, quantity: int = 1, permitir_meio_inativo: bool = False) -> TournamentPlayer:
        """Registra UMA OU MAIS recompras do jogador, numa ida só.

        `quantity` existe por desempenho medido, não por elegância: o banco deste
        projeto fica em outra região (us-west-2) e cada ida custa ~270ms de rede.
        Uma recompra faz ~6 consultas, então a "recompra dupla" feita em duas
        chamadas separadas cobrava a conta duas vezes — com três, o operador
        esperava perto de 6 segundos com a fila no balcão.

        Com a quantidade aqui dentro, as CONFERÊNCIAS acontecem uma vez só
        (inscrição, caixa aberto, trava de vendas, tipo de buy) e as ESCRITAS
        viram uma atualização de contadores e um único insert com N linhas.
        Três recompras passam de ~18 consultas para ~6.

        De quebra fica ATÔMICO no que importa: antes, se a segunda recompra
        falhasse, a primeira já tinha sido gravada e o jogador ficava com fichas
        a menos do que pagou.

        EM DEPRECIAÇÃO: `quantity` nasceu para dar conta da "recompra dupla"
        multiplicando o rebuy simples, e isso é uma conta errada — a recompra
        dupla tem valor e fichas próprios, que agora vivem no meio de entrada
        (`buy_types.amount`/`chips`). O parâmetro CONTINUA valendo porque o
        deploy não é atômico: um Caixa antigo já aberto no navegador segue
        mandando `quantity=3`, e ignorá-lo registraria UMA recompra onde o
        jogador pagou três — dinheiro a menos no caixa. Só sai quando não
        houver mais nenhuma tela antiga em uso.
        """
        quantity = max(1, int(quantity or 1))
        # Get tournament player info with tournament_day data
        tp_response = _ler_inscrito_com_o_dia(
            tournament_player_id,
            "rebuy_amount, rebuy_chips, rebuy_level_limit, rake_percentage, "
            "blind_duration, start_time, updated_at, created_at",
        )
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Idempotência (replay offline): se a transação deste rebuy já existe
        # (mesmo client_mutation_id), não re-incrementa contadores — devolve o tp atual.
        ja_registrado = TournamentPlayerService._venda_ja_registrada(tp, client_mutation_id, quantity)
        if ja_registrado is not None:
            return ja_registrado

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        if not skip_sales_block:
            # O dia já veio embutido na leitura acima — passar `day_row` evita
            # reler `tournament_days` só para saber se está bloqueado.
            SalesBlockService.assert_sales_allowed(
                tp["tournament_id"],
                tp.get("tournament_day_id"),
                day_row=tp.get("tournament_days"),
                # A etapa veio embutida na mesma leitura — passar aqui evita a
                # segunda ida ao banco que acontecia em TODA venda.
                stage_row=tp.get("tournaments"),
            )
        day_info = tp.get("tournament_days", {}) or {}
        # O meio de entrada escolhido diz valor, rake E fichas. É daqui que sai
        # o "rebuy duplo": ele não é o rebuy simples vezes dois, é uma venda com
        # valor e pilha próprios. Sem tipo escolhido, tudo continua vindo do dia.
        buy_type = TournamentPlayerService._get_buy_type(
            buy_type_id, tp["tournament_id"], permitir_inativo=permitir_meio_inativo
        )
        rebuy_amount, rake_pct = TournamentPlayerService._valor_e_rake(
            buy_type, day_info.get("rebuy_amount"), day_info.get("rake_percentage")
        )
        rebuy_chips = TournamentPlayerService._fichas_do_tipo(
            buy_type, day_info.get("rebuy_chips") or 10000
        )

        # Check if rebuys are still allowed based on blind level (o nível atual é
        # calculado pelo relógio do dia quando o caixa não informa).
        TournamentPlayerService._recusar_rebuy_fora_do_nivel(day_info, current_blind_level, skip_level_gate)

        # Update tournament player - if eliminated, reactivate them
        # Uma atualização só, com os contadores já multiplicados: N recompras não
        # podem virar N idas ao banco (ver docstring).
        valor_total = rebuy_amount * quantity
        updated_data = {
            "rebuy_count": tp["rebuy_count"] + quantity,
            "total_rebuy_amount": float(tp["total_rebuy_amount"]) + valor_total,
            "total_chips": tp["total_chips"] + (rebuy_chips * quantity),
            "status": "active",  # Reactivate player if they were eliminated
        }

        response = supabase.table("tournament_players").update(updated_data).eq("id", tournament_player_id).execute()

        # Invalidate chipcount cache for this day
        _chipcount_cache.pop(tp.get("tournament_day_id"), None)

        # Handle credit payment for rebuy
        # O crédito é consumido pelo valor TOTAL das N recompras — cobrar só uma e
        # gravar N deixaria o saldo do jogador maior do que ele tem.
        actual_payment_source = TournamentPlayerService._pagar_com_credito(
            tp, valor_total, "rebuy", payment_source, user_id
        )

        # Create transaction
        # UMA linha por recompra (o relatório e a bolsa de prêmios contam linhas,
        # não somam quantidade), mas UM ÚNICO insert com as N de uma vez.
        def _linha(indice: int) -> dict:
            linha = {
                "tournament_id": tp["tournament_id"],
                "player_id": tp["player_id"],
                "tournament_player_id": tournament_player_id,
                "type": "rebuy",
                "amount": rebuy_amount,
                "payment_source": actual_payment_source,
                "payment_method": payment_method or "cash",
                "buy_type_id": buy_type_id,
                "buy_type_name": (buy_type or {}).get("name"),
                "rake_percentage": rake_pct,
                "rake_amount": round(rebuy_amount * rake_pct / 100, 2),
                # Fichas de UMA recompra por linha (o lote grava N linhas): é
                # exatamente o que o estorno de UMA delas precisa devolver.
                "chips": rebuy_chips,
                "created_by": user_id,
            }
            if client_mutation_id:
                # Cada linha precisa do SEU identificador, senão o replay da fila
                # offline acharia a primeira e concluiria que as N já entraram.
                linha["client_id"] = (
                    client_mutation_id if quantity == 1
                    else f"{client_mutation_id}:{indice}"
                )
            return linha

        supabase.table("transactions").insert([_linha(i) for i in range(quantity)]).execute()

        # Quem recompra volta para a mesa: a recompra DESFAZ uma eliminacao.
        # Sem isto o telao mostrava "2 entradas - 0 eliminacoes = 7 ativos",
        # porque as recompras eram somadas aos ativos em vez de cancelarem uma
        # eliminacao. Com 100 entradas: elimina o jogador X (99 ativos), X
        # recompra e voltam as mesmas 100.
        #
        # UMA por VENDA, nao por recompra: o jogador que compra 5 recompras de
        # uma vez foi ao caixa UMA vez e sentou UMA vez. Descontar 5 daria 104
        # ativos num torneio de 100 entradas.
        TournamentPlayerService._desfazer_eliminacoes(tp.get("tournament_day_id"))

        return TournamentPlayer(**response.data[0])

    @staticmethod
    def _desfazer_eliminacoes(day_id) -> None:
        """Baixa em UM o contador de eliminacoes do dia, com piso em zero.

        Uma por venda, seja ela de uma recompra ou de cinco: o jogador foi ao
        caixa uma vez e voltou para a mesa uma vez.

        Falhar aqui NAO pode derrubar a venda: o dinheiro ja entrou e a recompra
        ja esta gravada. O pior caso e o telao mostrar um ativo a menos ate o
        operador ajustar no botao — muito melhor que recusar uma venda paga.
        """
        if not day_id:
            return
        try:
            supabase.rpc(
                "desfazer_eliminacoes", {"p_day_id": str(day_id), "p_qtd": 1},
            ).execute()
        except Exception:
            # Banco ainda sem a funcao (o deploy do codigo nao e atomico com a
            # migracao): cai no caminho em duas idas. Aqui duas caixas vendendo
            # ao mesmo tempo podem perder uma volta — e por isso que o caminho
            # bom e a funcao.
            try:
                atual = (
                    supabase.table("tournament_days")
                    .select("eliminations_count")
                    .eq("id", day_id)
                    .execute()
                    .data
                    or [{}]
                )[0].get("eliminations_count") or 0
                supabase.table("tournament_days").update(
                    {"eliminations_count": max(0, atual - 1)}
                ).eq("id", day_id).execute()
            except Exception:
                pass

    @staticmethod
    def add_addon(tournament_player_id: str, user_id: str, payment_source: str = "cash", payment_method: str = "cash", buy_type_id: str = None, client_mutation_id: str = None, skip_sales_block: bool = False, permitir_meio_inativo: bool = False) -> TournamentPlayer:
        """Add an add-on for a tournament player"""
        # Get tournament player info with tournament_day data
        tp_response = _ler_inscrito_com_o_dia(
            tournament_player_id, "addon_amount, addon_chips, rake_percentage"
        )
        if not tp_response.data:
            raise ValueError("Tournament player not found")

        tp = tp_response.data[0]

        # Idempotência (replay offline): addon já aplicado? devolve o tp atual.
        ja_registrado = TournamentPlayerService._venda_ja_registrada(tp, client_mutation_id)
        if ja_registrado is not None:
            return ja_registrado

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, tp["tournament_id"])
        if not skip_sales_block:
            # Mesmo motivo do rebuy: o dia embutido poupa uma consulta.
            SalesBlockService.assert_sales_allowed(
                tp["tournament_id"],
                tp.get("tournament_day_id"),
                day_row=tp.get("tournament_days"),
                # A etapa veio embutida na mesma leitura — passar aqui evita a
                # segunda ida ao banco que acontecia em TODA venda.
                stage_row=tp.get("tournaments"),
            )
        day_info = tp.get("tournament_days", {}) or {}
        # Mesma regra da recompra: o meio de entrada escolhido diz valor, rake e
        # fichas; sem ele, tudo continua vindo do dia.
        buy_type = TournamentPlayerService._get_buy_type(
            buy_type_id, tp["tournament_id"], permitir_inativo=permitir_meio_inativo
        )
        addon_amount, rake_pct = TournamentPlayerService._valor_e_rake(
            buy_type, day_info.get("addon_amount"), day_info.get("rake_percentage")
        )
        addon_chips = TournamentPlayerService._fichas_do_tipo(
            buy_type, day_info.get("addon_chips") or 10000
        )

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
        actual_payment_source = TournamentPlayerService._pagar_com_credito(
            tp, addon_amount, "addon", payment_source, user_id
        )

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
            "buy_type_name": (buy_type or {}).get("name"),
            "rake_percentage": rake_pct,
            "rake_amount": round(addon_amount * rake_pct / 100, 2),
            # Mesmo motivo do buy-in: o estorno devolve ESTE número, não o que o
            # tipo disser no dia em que alguém cancelar.
            "chips": addon_chips,
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
