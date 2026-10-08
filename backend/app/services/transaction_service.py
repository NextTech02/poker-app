import re
import logging
from typing import List, Optional, Tuple
from datetime import datetime, timezone

from app.database import supabase
from app.services.allocation_service import liberar_assento_do_dia
from app.services.eliminacao import MODO_MESA, modo_do_torneio, recontar_eliminacoes, registrar_eliminacao
from app.models.transaction import TransactionCreate, Transaction, TransactionDetail
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService
from app.services.transaction_filters import sem_canceladas
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

# Só entradas podem ser estornadas por aqui. Prêmio pago é saída de caixa e tem
# fluxo próprio (prize_allocations); desfazê-lo aqui devolveria fichas a quem já
# recebeu o dinheiro.
TIPOS_ESTORNAVEIS = ("buy_in", "rebuy", "addon")

# Passos do estorno, na ordem em que rodam. O nome de cada passo CONCLUÍDO fica
# gravado em `transactions.cancel_steps`: é isso que permite a uma retentativa
# retomar exatamente o que faltou, sem repetir o que já saiu do caixa.
PASSO_CONTADORES = "contadores"
PASSO_CAIXA_ETAPA = "caixa_etapa"
PASSO_CAIXA_OPERADOR = "caixa_operador"
PASSO_FIDELIDADE = "fidelidade"

# Colunas do jogador lidas junto de uma transação. Vive numa constante porque as
# telas de caixa e de relatório mostram nome E apelido: mudar a lista num lugar
# e esquecer nos outros faria uma tela exibir o apelido e a outra não.
COLUNAS_JOGADOR = "name, nickname"


class TransactionService:
    @staticmethod
    def create_transaction(transaction_data: TransactionCreate, user_id: str) -> TransactionDetail:
        """Create a new transaction"""
        data = transaction_data.model_dump()
        data["created_by"] = user_id

        # Block when the operator has no open cashbox (super-admins bypass)
        CashboxService.require_open_cashbox_for_tournament(user_id, data["tournament_id"])

        # Vendas encerradas pelo diretor (dia ou etapa)?
        if data.get("type") in TIPOS_ESTORNAVEIS:
            SalesBlockService.assert_sales_allowed(data["tournament_id"])

        # Get tournament player ID if exists.
        # A ORDEM é a MESMA de SalesBlockService.dia_da_venda (registered_at
        # crescente, id como desempate) e não é enfeite: o jogador inscrito no
        # 1A e no 1B do mesmo torneio tem duas linhas aqui. Sem ORDER BY, o
        # Postgres devolve na ordem que quiser (um UPDATE em tournament_players
        # reescreve a tupla no fim do heap e inverte a ordem física), e a trava
        # de vendas conferia UM dia enquanto a venda era gravada no OUTRO.
        tp_response = (
            supabase.table("tournament_players").select("id")
            .eq("tournament_id", data["tournament_id"])
            .eq("player_id", data["player_id"])
            .order("registered_at")
            .order("id")
            .execute()
        )
        if tp_response.data:
            data["tournament_player_id"] = tp_response.data[0]["id"]

        response = supabase.table("transactions").insert(data).execute()
        trans = response.data[0]

        # Get related info
        tournament = supabase.table("tournaments").select("name").eq("id", data["tournament_id"]).execute()
        player = supabase.table("players").select(COLUNAS_JOGADOR).eq("id", data["player_id"]).execute()

        tournament_name = tournament.data[0]["name"] if tournament.data else ""
        player_info = player.data[0] if player.data else {}

        return TransactionDetail(
            **trans,
            tournament_name=tournament_name,
            player_name=player_info.get("name", ""),
            player_nickname=player_info.get("nickname")
        )

    # ============================================================
    # Estorno lógico (cancelamento) de uma venda
    # ============================================================
    #
    # NUNCA apaga a linha. Os três triggers que movem dinheiro na INSERÇÃO
    # (`update_stage_cash_on_transaction`, `mirror_transaction_to_cashbox` e
    # `loyalty_earn_on_transaction`) são todos INSERT-only: nenhum desfaz nada.
    # Um DELETE deixaria o caixa da etapa e o caixa do operador inflados para
    # sempre, e os pontos de fidelidade creditados. Então cada um deles é
    # desfeito EXPLICITAMENTE aqui.
    #
    # O único agregado que se conserta sozinho é `tournament_days.prize_pool`:
    # o trigger `on_transaction_prize_pool_update` também dispara em UPDATE e
    # recalcula a bolsa pelas entradas sobreviventes, já ignorando as
    # canceladas (database_migration_cancel_sale.sql).
    #
    # Isto roda no service, e não numa função SECURITY DEFINER, porque o
    # backend executa as queries com o JWT do usuário: assim o RLS por
    # organização vale em cada passo do estorno.
    #
    # O que o estorno NÃO alcança sozinho volta como AVISO no retorno da API
    # (TransactionDetail.cancel_warnings), nunca em silêncio: dinheiro que já foi
    # sangrado para o caixa geral/rake e cashback que já virou crédito do
    # jogador. É o admin que conserta esses dois, e ele precisa saber na hora.

    @staticmethod
    def get_raw_transaction(transaction_id: str) -> Optional[dict]:
        """Linha crua de `transactions` — usada pelo router para validar escopo
        de etapa e autoria antes de deixar mexer na venda."""
        resp = supabase.table("transactions").select("*").eq("id", transaction_id).execute()
        return resp.data[0] if resp.data else None

    @staticmethod
    def cancel_transaction(transaction_id: str, user_id: str, reason: str) -> TransactionDetail:
        """Cancela uma venda e desfaz TUDO o que ela movimentou.

        O cancelamento tem DOIS estados por um motivo caro: 'cancelling' (a
        venda já saiu de todas as somas, o estorno está em andamento) e
        'cancelled' (todos os passos terminaram). Marcar 'cancelled' de cara —
        como se fazia antes — significava que um passo que estourasse no meio
        deixava o resto por fazer PARA SEMPRE: a retentativa via "já cancelada"
        e devolvia sucesso enquanto o caixa da etapa continuava inflado.
        """
        resp = supabase.table("transactions").select("*").eq("id", transaction_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "transacao_nao_encontrada", "Transação não encontrada", status=404
            )
        tx = resp.data[0]
        estado = tx.get("status") or "active"

        if estado == "cancelled":
            # Idempotente: dois cliques não podem debitar o caixa duas vezes.
            return TransactionService._detalhar(tx)

        if tx.get("type") not in TIPOS_ESTORNAVEIS:
            raise ErroDeNegocio(
                "venda_nao_estornavel",
                "Apenas entradas (buy-in, rebuy e add-on) podem ser canceladas",
                tipo=tx.get("type"),
            )

        # Crédito e ticket exigem devolver saldo/bilhete ao jogador, e não existe
        # inversa de PlayerCreditService.use_credit nem "des-resgate" de ticket.
        # Cancelar sem devolver seria confiscar o crédito do jogador.
        origem = tx.get("payment_source") or "cash"
        if origem != "cash":
            # A origem vai como dado: a tela precisa dizer SE foi crédito ou
            # ticket para o admin saber qual saldo ajustar na mão.
            raise ErroDeNegocio(
                "venda_com_credito_nao_estornavel",
                "Venda paga com crédito ou ticket ainda não pode ser cancelada — "
                "ajuste manualmente o saldo do jogador",
                origem=origem,
            )

        TransactionService._exigir_recompras_canceladas(tx)

        if estado == "cancelling":
            # RETOMADA: um estorno anterior parou no meio (timeout, RLS, rede).
            # Os passos já concluídos estão registrados na própria linha.
            linha = tx
            passos = set(tx.get("cancel_steps") or [])
        else:
            linha, passos = TransactionService._marcar_em_cancelamento(
                transaction_id, user_id, reason
            )
            if passos is None:
                # Já estava cancelada quando fomos escrever: nada a desfazer.
                return TransactionService._detalhar(linha)

        valor = float(tx.get("amount") or 0)
        avisos: List[str] = []
        avisos += TransactionService._passo(
            transaction_id, passos, PASSO_CONTADORES,
            lambda: TransactionService._desfazer_contadores_do_jogador(tx, valor),
        )
        avisos += TransactionService._passo(
            transaction_id, passos, PASSO_CAIXA_ETAPA,
            lambda: TransactionService._desfazer_caixa_da_etapa(transaction_id, tx, valor),
        )
        avisos += TransactionService._passo(
            transaction_id, passos, PASSO_CAIXA_OPERADOR,
            lambda: TransactionService._desfazer_caixa_do_operador(tx, valor, user_id, reason),
        )
        avisos += TransactionService._passo(
            transaction_id, passos, PASSO_FIDELIDADE,
            lambda: TransactionService._desfazer_fidelidade(tx, valor),
        )

        # Só agora a venda vira 'cancelled': enquanto faltar qualquer passo ela
        # fica em 'cancelling' e a próxima tentativa retoma o que sobrou.
        final = (
            supabase.table("transactions")
            .update({"status": "cancelled"})
            .eq("id", transaction_id)
            .execute()
        )
        detalhe = TransactionService._detalhar((final.data or [linha])[0])
        detalhe.cancel_warnings = avisos
        return detalhe

    @staticmethod
    def _marcar_em_cancelamento(transaction_id: str, user_id: str, reason: str):
        """Compare-and-swap que dá a UM pedido o direito de estornar a venda.

        Devolve (linha, passos_já_feitos). `passos` vem None quando a venda já
        estava cancelada — aí não há nada a desfazer.
        """
        agora = datetime.now(timezone.utc).isoformat()
        try:
            marcada = (
                supabase.table("transactions")
                .update({
                    "status": "cancelling",
                    "cancelled_at": agora,
                    "cancelled_by": user_id,
                    "cancel_reason": reason,
                    "cancel_steps": [],
                })
                .eq("id", transaction_id)
                # Os dois neq (e não um eq('status','active')) toleram a linha
                # antiga com status nulo: ela também pode ser cancelada.
                .neq("status", "cancelled")
                .neq("status", "cancelling")
                .execute()
            )
        except Exception as exc:
            raise ErroDeNegocio(
                "cancelamento_sem_migracao",
                "Cancelamento indisponível: a migração do banco ainda não foi aplicada.",
            ) from exc

        if marcada.data:
            return marcada.data[0], set()

        atual = supabase.table("transactions").select("*").eq("id", transaction_id).execute().data[0]
        if (atual.get("status") or "active") == "cancelled":
            return atual, None
        # Outro pedido pegou a venda primeiro e está estornando agora: repetir os
        # débitos aqui tiraria o dinheiro do caixa duas vezes.
        #
        # 409 e não 400: o pedido está correto, ele só briga com um estorno que
        # já está em curso. É o que permite à tela oferecer "recarregar" em vez
        # de mandar o admin corrigir o que mandou.
        raise ErroDeNegocio(
            "cancelamento_em_andamento",
            "Esta venda já está sendo cancelada por outra operação — "
            "recarregue a tela para ver o resultado",
            status=409,
        )

    @staticmethod
    def _passo(transaction_id: str, feitos: set, nome: str, executar) -> List[str]:
        """Roda um passo do estorno UMA vez só e registra que ele terminou.

        O registro é gravado DEPOIS do passo, nunca antes: se o passo estourar,
        ele continua pendente e a próxima tentativa o executa. É isso que impede
        um estorno pela metade de virar permanente.
        """
        if nome in feitos:
            return []
        avisos = executar() or []
        feitos.add(nome)
        TransactionService._registrar_passo(transaction_id, feitos)
        return avisos

    @staticmethod
    def _registrar_passo(transaction_id: str, feitos: set) -> None:
        try:
            supabase.table("transactions").update(
                {"cancel_steps": sorted(feitos)}
            ).eq("id", transaction_id).execute()
        except Exception:
            # Perder o marcador só faz a retentativa repetir o passo; perder o
            # estorno inteiro seria muito pior. Fica no log para investigação.
            logger.exception(
                "Não foi possível registrar o progresso do estorno da venda %s", transaction_id
            )

    @staticmethod
    def _exigir_recompras_canceladas(tx: dict) -> None:
        """Buy-in só é cancelado depois das recompras do mesmo jogador.

        Cancelar o buy-in tira o jogador do dia e zera as fichas dele, mas os
        rebuys e add-ons continuariam ATIVOS: o clube ficaria com o dinheiro de
        um jogador que não está mais na mesa e a bolsa de prêmios seguiria
        premiando com ele. Cancelar em cascata por conta própria seria pior —
        são vendas separadas, cada uma com o seu motivo e a sua auditoria.
        """
        if tx.get("type") != "buy_in":
            return
        tp_id = tx.get("tournament_player_id")
        if not tp_id:
            return
        linhas = (
            supabase.table("transactions").select("*")
            .eq("tournament_player_id", tp_id).execute().data or []
        )
        pendentes = [
            l for l in sem_canceladas(linhas)
            if l.get("type") in ("rebuy", "addon") and l.get("id") != tx.get("id")
        ]
        if pendentes:
            # A QUANTIDADE também vai como dado: a frase é remontada no idioma
            # da tela, e o número é o que diz ao admin quantas vendas ele ainda
            # precisa estornar antes desta.
            raise ErroDeNegocio(
                "recompras_ativas_no_buy_in",
                f"Cancele primeiro as recompras deste jogador — "
                f"{len(pendentes)} rebuy/add-on ainda ativo(s) nesta inscrição",
                quantidade=len(pendentes),
            )

    @staticmethod
    def _desfazer_contadores_do_jogador(tx: dict, valor: float) -> List[str]:
        """Devolve o jogador ao estado anterior à venda.

        Quem impede a repetição é um RECIBO com chave primária gravado pelo
        BANCO na mesma instrução que mexe nos contadores
        (`undo_entry_counters_once`), e não um marcador escrito depois — que
        pode se perder em silêncio, de propósito.

        A LIBERAÇÃO DO ASSENTO fica FORA de qualquer guarda: é um DELETE, roda
        quantas vezes for preciso e dá o mesmo resultado. Era ela (junto com o
        desconto do dia) que a guarda por status da inscrição pulava na
        retomada, deixando a cadeira presa a um jogador que não está no evento
        e o dia com um inscrito a mais PARA SEMPRE — com o cancelamento
        respondendo SUCESSO.
        """
        from app.services.tournament_day_service import _chipcount_cache

        tp_id = tx.get("tournament_player_id")
        if not tp_id:
            return []
        tp_resp = supabase.table("tournament_players").select("*").eq("id", tp_id).execute()
        if not tp_resp.data:
            return []
        tp = tp_resp.data[0]
        day_id = tp.get("tournament_day_id")

        if not TransactionService._banco_acertou_os_contadores(tx["id"]):
            dia = {}
            if day_id:
                d = supabase.table("tournament_days").select("*").eq("id", day_id).execute()
                dia = d.data[0] if d.data else {}
            TransactionService._acertar_contadores_na_mao(tx, tp, dia, day_id, valor)

        if tx["type"] == "buy_in" and day_id:
            TransactionService._liberar_assento(tp, day_id)
        elif tx["type"] == "rebuy" and day_id:
            # Modo mesa: sem a reentrada, ele voltou a estar fora (o banco o
            # marcou 'eliminated'). Fora da mesa, a cadeira volta ao pool.
            atual = (
                supabase.table("tournament_players").select("status")
                .eq("id", tp_id).execute().data or []
            )
            if atual and atual[0].get("status") == "eliminated":
                TransactionService._liberar_assento(tp, day_id)

        _chipcount_cache.pop(day_id, None)
        return []

    @staticmethod
    def _refazer_eliminacao(tx: dict, tp: dict, day_id: str) -> None:
        """Estorno de REENTRADA: a eliminação que ela tinha desfeito volta.

        Toda reentrada trouxe UM eliminado de volta; cancelá-la o devolve à
        condição de eliminado:

        - modo MESA: o jogador volta a 'eliminated' (se está na mesa) e o
          contador é recontado;
        - modo EM MASSA: +1 no contador, com teto nas ENTRADAS. Exceção: as
          linhas 1..N de um lote antigo (`quantity`), gravadas como `cmid:1`,
          `cmid:2`... — aquela venda trouxe UM jogador de volta, então só a
          linha `:0` devolve.

        Só é usada no caminho anterior à migração — onde o RPC existe, o mesmo
        acerto acontece dentro dele, na mesma transação. Falhar aqui não derruba
        o estorno: o dinheiro já voltou, e o pior caso é um ativo a mais na TV
        até o operador ajustar.
        """
        try:
            if modo_do_torneio(tp.get("tournament_id"), supabase) == MODO_MESA:
                supabase.table("tournament_players").update(
                    {"status": "eliminated", "eliminated_at": "now()"}
                ).eq("id", tp["id"]).in_("status", ["active", "registered"]).execute()
                recontar_eliminacoes(day_id, supabase)
                return
            if re.search(r":[1-9][0-9]*$", str(tx.get("client_id") or "")):
                return
            registrar_eliminacao(day_id, 1, supabase)
        except Exception:
            logger.warning(
                "não consegui devolver a eliminação ao contador do dia %s", day_id,
                exc_info=True,
            )

    @staticmethod
    def _banco_acertou_os_contadores(transaction_id: str) -> bool:
        """Deixa o BANCO desfazer os contadores desta venda, uma vez só.

        Devolve True quando o acerto está garantido (o recibo já existia, ou o
        RPC respondeu). False só quando a migração ainda não foi aplicada — aí
        o chamador faz na mão, como antes.
        """
        if TransactionService._ja_acertou_os_contadores(transaction_id):
            return True
        try:
            supabase.rpc(
                "undo_entry_counters_once", {"p_transaction_id": transaction_id}
            ).execute()
            # O RPC RESPONDEU: o acerto (ou a recusa por recibo já existente)
            # aconteceu no banco. Repetir aqui pelo caminho manual tiraria as
            # fichas do jogador uma segunda vez.
            return True
        except Exception:
            logger.warning(
                "RPC undo_entry_counters_once indisponível; acertando os contadores "
                "pelo caminho anterior",
                exc_info=True,
            )
        # A chamada acima pode ter COMMITADO antes de a resposta se perder.
        return TransactionService._ja_acertou_os_contadores(transaction_id)

    @staticmethod
    def _ja_acertou_os_contadores(transaction_id: str) -> bool:
        """O recibo desta venda já existe? (guarda do passo dos contadores)

        Schema anterior à migração não tem a tabela: aí não há recibo para
        consultar e o acerto segue pelo caminho manual. Nunca devolvemos True
        por engano — isso deixaria o jogador com fichas que ele não pagou e o
        dia com um inscrito a mais.
        """
        try:
            r = (
                supabase.table("transaction_counter_refunds")
                .select("transaction_id")
                .eq("transaction_id", transaction_id)
                .execute()
            )
            return bool(r.data)
        except Exception:
            logger.warning(
                "transaction_counter_refunds indisponível; os contadores serão "
                "acertados sem recibo",
                exc_info=True,
            )
            return False

    @staticmethod
    def _acertar_contadores_na_mao(
        tx: dict, tp: dict, dia: dict, day_id: Optional[str], valor: float
    ) -> None:
        """Caminho anterior à migração: acerta os contadores fora do banco.

        DECREMENTO SIMPLES, de propósito. Recontar as recompras vivas e gravar
        o total parece mais elegante e é pior: `add_rebuy` grava rebuy_count e
        total_chips ANTES de inserir a linha em `transactions`, sem atomicidade.
        Quando a inserção falha (rede), o contador fica à frente das vendas — e
        recontar faz UM cancelamento tirar DUAS recompras do stack de um jogador
        que está na mesa com as fichas na frente dele. Pior ainda: a recontagem
        lê o jogador num instante e as vendas em outro, então uma recompra
        vendida nessa janela tinha as fichas apagadas.

        No fim ele tenta deixar o recibo assim mesmo. Onde a tabela já existe
        (o RPC falhou por outro motivo), a próxima tentativa fica protegida
        igual. Onde ela ainda não existe, a proteção volta a ser só
        `cancel_steps`: marcador perdido + segundo clique desconta duas vezes.
        É o mesmo compromisso que o caixa da etapa já assume enquanto a migração
        não roda, e vale a corrida rara contra o erro certo do outro lado.
        """
        refazer = False
        if tx["type"] in ("rebuy", "addon"):
            if tx["type"] == "rebuy":
                campo_conta, campo_total = "rebuy_count", "total_rebuy_amount"
                fichas_do_dia = int(dia.get("rebuy_chips") or 0)
            else:
                campo_conta, campo_total = "addon_count", "total_addon_amount"
                fichas_do_dia = int(dia.get("addon_chips") or 0)
            # As fichas voltam pelo que a VENDA entregou, não pelo que o dia
            # cobra hoje: desde os meios de entrada por dia, uma "recompra
            # dupla" entrega o dobro da pilha, e devolver `rebuy_chips` deixaria
            # metade das fichas na mesa de um jogador que já foi estornado.
            # Venda antiga não tem o número gravado — aí vale o campo do dia,
            # que é exatamente o que ela usou quando aconteceu.
            fichas_da_venda = tx.get("chips")
            fichas_do_tipo = (
                int(fichas_da_venda) if fichas_da_venda is not None else fichas_do_dia
            )
            dados = {
                campo_conta: max(int(tp.get(campo_conta) or 0) - 1, 0),
                campo_total: max(round(float(tp.get(campo_total) or 0) - valor, 2), 0.0),
                "total_chips": max(int(tp.get("total_chips") or 0) - fichas_do_tipo, 0),
            }
            # A venda da reentrada tinha baixado o contador de eliminações (quem
            # reentra volta à mesa); o estorno devolve. Sem isto o telão fica
            # com um jogador ativo a mais para sempre, e ninguém percebe: o
            # número está a um dígito do certo. UMA por reentrada estornada —
            # cada uma trouxe um eliminado de volta (ver _refazer_eliminacao).
            refazer = tx["type"] == "rebuy" and day_id
        else:
            # Buy-in cancelado = inscrição desfeita: o jogador sai do dia.
            # `buy_in_count` precisa zerar junto com o valor: é ELE que todo
            # agregado de ENTRADAS conta (total do dia na tela e no telão,
            # relatório do dia, relatório por jogador, view player_statistics).
            # Sem zerar, o dia mostra 78 entradas com receita de 77 e o perfil
            # do jogador exibe um torneio que ele não disputou.
            dados = {
                "status": "cancelled",
                "total_buy_in_amount": 0,
                "buy_in_count": 0,
                "total_chips": 0,
            }

        # `total_spent` é recalculado pelo trigger BEFORE UPDATE a partir dos
        # três totais, mas vai gravado junto: assim o número fica certo mesmo
        # sem o trigger, e o teste consegue conferir.
        atual = dict(tp)
        atual.update(dados)
        dados["total_spent"] = round(
            float(atual.get("total_buy_in_amount") or 0)
            + float(atual.get("total_rebuy_amount") or 0)
            + float(atual.get("total_addon_amount") or 0), 2
        )
        supabase.table("tournament_players").update(dados).eq("id", tp["id"]).execute()

        if tx["type"] in ("rebuy", "addon") and refazer:
            TransactionService._refazer_eliminacao(tx, tp, day_id)

        if tx["type"] == "buy_in" and day_id:
            # O trigger de contagem só dispara em INSERT/DELETE da linha; aqui é
            # UPDATE, então o inscrito precisa ser descontado na mão — senão o
            # dia parece cheio e o Caixa recusa o próximo jogador.
            #
            # MENOS UM, e não uma recontagem das inscrições vivas do dia:
            # `registered_players` do dia FINAL também recebe os classificados
            # que `_avancar_por_contador` soma sem criar linha nenhuma em
            # `tournament_players` (tournament_day_service.py). Recontar apagaria
            # todos eles de uma vez.
            inscritos = max(int(dia.get("registered_players") or 0) - 1, 0)
            supabase.table("tournament_days").update(
                {"registered_players": inscritos}
            ).eq("id", day_id).execute()

            # Uma entrada a menos: o contador de eliminações não pode passar
            # das ENTRADAS (ativos negativos na TV). No modo mesa, ele é a
            # contagem dos eliminados — e o estornado saiu dela.
            try:
                if modo_do_torneio(tp.get("tournament_id"), supabase) == MODO_MESA:
                    recontar_eliminacoes(day_id, supabase)
                else:
                    registrar_eliminacao(day_id, 0, supabase)
            except Exception:
                logger.warning(
                    "não consegui acertar o contador de eliminações do dia %s", day_id,
                    exc_info=True,
                )

        # Feito na mão, o recibo fica assim mesmo: é ele que a próxima tentativa
        # consulta. Só falha no banco sem a migração — e aí a proteção volta a
        # ser a de sempre, `cancel_steps`.
        try:
            supabase.table("transaction_counter_refunds").insert({
                "transaction_id": tx["id"],
                "tournament_player_id": tp["id"],
                "organization_id": tx.get("organization_id"),
            }).execute()
        except Exception:
            logger.info(
                "Sem recibo para o acerto de contadores da venda %s (migração pendente)",
                tx.get("id"),
            )

    @staticmethod
    def _liberar_assento(tp: dict, day_id: Optional[str]) -> None:
        """Devolve a cadeira do jogador ao pool de lugares livres — só a DO DIA.

        As mesas são por dia (database_migration_table_management_per_day.sql).
        Apagar por (torneio, jogador) tiraria da cadeira o mesmo jogador no 1B,
        que está sentado jogando agora, e outro seria alocado no lugar dele. A
        vaga da mesa (`occupied_seats`) volta junto.
        """
        liberar_assento_do_dia(tp["tournament_id"], tp["player_id"], day_id, supabase)

    @staticmethod
    def _desfazer_caixa_da_etapa(transaction_id: str, tx: dict, valor: float) -> List[str]:
        """Tira do caixa da etapa o dinheiro devolvido ao jogador.

        Pode deixar o saldo NEGATIVO se a venda já tiver sido sangrada. Isso é
        a realidade (falta esse dinheiro na gaveta) e não deve ser mascarado
        com um piso em zero — mascarar esconderia a diferença do fechamento.
        Mas TEM de ser avisado: a sangria já mandou esse dinheiro para o caixa
        geral e para o rake acumulado, e o estorno não corrige nenhum dos dois.

        GUARDA PRÓPRIA: o recibo em `stage_cash_refunds` (uma linha por venda)
        decide sozinho se este passo já rodou. Não dá para depender de
        `cancel_steps`, que é gravado numa SEGUNDA chamada e cujo erro é
        engolido de propósito: perdido o marcador, o admin que clica "cancelar"
        de novo debitaria os mesmos R$ 100 do caixa da etapa pela segunda vez e
        a etapa fecharia faltando dinheiro que ninguém tirou da gaveta.
        """
        if not valor:
            return []
        t = supabase.table("tournaments").select("stage_id").eq("id", tx["tournament_id"]).execute()
        stage_id = t.data[0].get("stage_id") if t.data else None
        if not stage_id:
            return []
        caixa = supabase.table("stage_cash_register").select("*").eq("stage_id", stage_id).execute()
        if not caixa.data:
            return []
        atual = caixa.data[0]

        if TransactionService._ja_estornou_o_caixa_da_etapa(transaction_id):
            # Retomada depois do débito: o dinheiro já saiu. Só o AVISO é
            # recalculado — o admin precisa vê-lo mesmo na segunda tentativa.
            saldo = float(atual.get("current_balance") or 0)
        else:
            saldo = TransactionService._debitar_caixa_da_etapa(
                transaction_id, stage_id, valor, atual
            )

        avisos: List[str] = []
        rake = float(tx.get("rake_amount") or 0)
        sangrado = float(atual.get("total_sangrias") or 0)
        if saldo is not None and saldo < 0:
            avisos.append(
                f"O caixa da etapa ficou negativo em R$ {abs(saldo):.2f}: este dinheiro já "
                f"tinha sido sangrado. O caixa geral e o rake acumulado NÃO foram corrigidos "
                f"automaticamente — ajuste-os no Financeiro antes de fechar a noite."
            )
        elif sangrado > 0 and rake > 0:
            avisos.append(
                f"Esta etapa já teve sangria. Se o rake de R$ {rake:.2f} desta venda já foi "
                f"extraído, o caixa geral e o rake acumulado seguem contando esse valor — "
                f"confira no Financeiro."
            )
        return avisos

    @staticmethod
    def _ja_estornou_o_caixa_da_etapa(transaction_id: str) -> bool:
        """O recibo desta venda já existe? (guarda do passo do caixa da etapa)

        Schema anterior à migração não tem a tabela: aí não há recibo nenhum
        para consultar e o passo segue como sempre seguiu. Nunca devolvemos
        True por engano — isso deixaria o caixa da etapa inflado para sempre.
        """
        try:
            r = (
                supabase.table("stage_cash_refunds")
                .select("transaction_id")
                .eq("transaction_id", transaction_id)
                .execute()
            )
            return bool(r.data)
        except Exception:
            logger.warning(
                "stage_cash_refunds indisponível; o estorno do caixa da etapa segue sem recibo",
                exc_info=True,
            )
            return False

    @staticmethod
    def _saldo_do_rpc(dados) -> Optional[float]:
        """Extrai o saldo devolvido pelo RPC (escalar, lista ou linha)."""
        if isinstance(dados, list):
            dados = dados[0] if dados else None
        if isinstance(dados, dict):
            dados = next(iter(dados.values()), None)
        return None if dados is None else float(dados)

    @staticmethod
    def _debitar_caixa_da_etapa(
        transaction_id: str, stage_id: str, valor: float, atual: dict
    ) -> Optional[float]:
        """Débito RELATIVO no caixa da etapa, feito pelo BANCO.

        Ler o saldo no Python e gravar o total calculado perde um dos débitos
        quando dois cancelamentos (ou um cancelamento e a venda seguinte, que o
        trigger soma) caem juntos: o caixa fecharia com sobra e ninguém
        conseguiria rastrear qual estorno se perdeu. O RPC faz
        `current_balance = current_balance - :valor` numa instrução só, junto
        com o recibo que impede a repetição.

        Devolve o saldo resultante, ou None quando ele não pôde ser lido —
        None significa "não sei o saldo", NUNCA "não debitei".
        """
        try:
            r = supabase.rpc(
                "debit_stage_cash_register_once",
                {"p_stage_id": stage_id, "p_amount": valor,
                 "p_transaction_id": transaction_id},
            ).execute()
            # O RPC RESPONDEU: o débito aconteceu no banco, ponto. Resposta
            # vazia (current_balance nulo, ou lista vazia) é saldo desconhecido
            # e não autoriza debitar de novo por outro caminho — era assim que
            # o mesmo estorno saía duas vezes do caixa da etapa sem que
            # nenhuma exceção tivesse sido levantada.
            return TransactionService._saldo_do_rpc(r.data)
        except Exception:
            logger.warning(
                "RPC debit_stage_cash_register_once indisponível; tentando o caminho anterior",
                exc_info=True,
            )

        # A chamada acima pode ter COMMITADO antes de a resposta se perder.
        # Se o recibo já está gravado, o banco debitou: repetir aqui tiraria o
        # dinheiro do caixa da etapa duas vezes na MESMA tentativa.
        if TransactionService._ja_estornou_o_caixa_da_etapa(transaction_id):
            return None

        try:
            r = supabase.rpc(
                "debit_stage_cash_register",
                {"p_stage_id": stage_id, "p_amount": valor},
            ).execute()
            return TransactionService._saldo_do_rpc(r.data)
        except Exception:
            logger.warning(
                "RPC debit_stage_cash_register indisponível; debitando pelo caminho antigo",
                exc_info=True,
            )

        # Migração ainda não aplicada: read-modify-write, como antes. Vale a
        # corrida rara contra deixar o caixa da etapa inflado com certeza.
        novo = round(float(atual.get("current_balance") or 0) - valor, 2)
        supabase.table("stage_cash_register").update({
            "current_balance": novo,
            "total_received": round(float(atual.get("total_received") or 0) - valor, 2),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("stage_id", stage_id).execute()
        return novo

    @staticmethod
    def _desfazer_caixa_do_operador(tx: dict, valor: float, user_id: str, reason: str) -> List[str]:
        """Lança o estorno no ledger do caixa modular.

        O ledger é append-only (é o que dá auditoria ao fechamento), então o
        estorno entra como um movimento NEGATIVO amarrado à venda original — o
        trigger de saldo cuida de `cashboxes.current_balance`.

        O tipo é `refund`, e NÃO `adjustment`: 'adjustment' é a diferença de
        contagem do fechamento, que o relatório de sessão exclui de propósito do
        saldo esperado (cashbox_service._compute_session_report). Lançar o
        estorno como ajuste fazia o relatório acusar o operador de faltar os
        R$ 100 que o admin devolveu ao jogador.
        """
        cashbox_id = tx.get("cashbox_id")
        if not cashbox_id or not valor:
            return []

        # Retomada de estorno interrompido: o ledger é append-only, então um
        # segundo lançamento tiraria o dinheiro do caixa do operador duas vezes.
        # (A linha da venda original também tem transaction_id, daí o filtro de
        # tipo — ela é 'buy_in'/'rebuy'/'addon'.)
        ja = (
            supabase.table("cashbox_transactions").select("id, type, session_id")
            .eq("transaction_id", tx["id"]).execute()
        )
        lancamentos = ja.data or []
        if any(l.get("type") in ("refund", "adjustment") for l in lancamentos):
            return []

        cb = supabase.table("cashboxes").select("*").eq("id", cashbox_id).execute()
        aberta = cb.data[0].get("current_session_id") if cb.data else None
        avisos: List[str] = []
        da_venda = next((l.get("session_id") for l in lancamentos if l.get("session_id")), None)
        sessao = aberta or TransactionService._sessao_do_estorno(cashbox_id, da_venda)
        if aberta and da_venda and da_venda != aberta:
            # A venda foi de OUTRA sessão (ontem), e hoje há uma sessão aberta.
            # O lançamento cai na de hoje porque é a única em que ele ainda pode
            # entrar — mas o operador de hoje fecharia a noite devendo um
            # dinheiro que o ADMIN entregou ao jogador, sem nada explicando.
            avisos.append(
                f"A venda foi registrada em outra sessão do caixa deste operador. A devolução de "
                f"R$ {valor:.2f} entra na sessão ABERTA agora e vai aparecer como diferença no "
                f"fechamento de hoje. O dinheiro sai do caixa geral, não da gaveta do operador."
            )
        if not aberta:
            # Caso mais comum de todos: o admin cancela no dia seguinte, com o
            # caixa do operador já fechado. Deixar `session_id` nulo faz o
            # lançamento sumir do extrato — `get_session_reports` lê por sessão
            # — e o desconto no saldo do caixa é apagado na próxima abertura,
            # que regrava `current_balance = initial_balance`. Sobrava o buy-in
            # sem a devolução: o operador aparecia devendo o dinheiro que o
            # ADMIN entregou ao jogador.
            if sessao:
                avisos.append(
                    f"O caixa do operador já estava fechado: a devolução de R$ {valor:.2f} entrou "
                    f"na sessão em que a venda foi registrada e vai aparecer como diferença no "
                    f"relatório daquela sessão. O dinheiro sai do caixa geral, não da gaveta do operador."
                )
            else:
                avisos.append(
                    f"A devolução de R$ {valor:.2f} não pôde ser amarrada a nenhuma sessão do caixa "
                    f"do operador — ela NÃO vai aparecer no relatório de sessões. Registre o "
                    f"pagamento ao jogador no Financeiro."
                )

        linha = {
            "cashbox_id": cashbox_id,
            "session_id": sessao,
            "type": "refund",
            "amount": valor,
            "signed_amount": -valor,
            "transaction_id": tx["id"],
            "performed_by": user_id,
            "notes": f"Estorno de venda cancelada: {reason}",
        }
        if tx.get("organization_id"):
            # A coluna é NOT NULL e o DEFAULT depende do claim da sessão; o
            # caminho do sync/admin não tem claim, então vai explícito.
            linha["organization_id"] = tx["organization_id"]
        try:
            supabase.table("cashbox_transactions").insert(linha).execute()
        except Exception:
            # CHECK antigo (sem 'refund'): o deploy do backend não é atômico com
            # a migração. Grava como 'adjustment' MAS com transaction_id — é por
            # ele que o relatório reconhece o estorno e não o confunde com o
            # ajuste de contagem (cashbox_service._eh_estorno).
            logger.warning(
                "cashbox_transactions ainda não aceita 'refund'; gravando o estorno "
                "como 'adjustment' vinculado à venda",
                exc_info=True,
            )
            linha["type"] = "adjustment"
            supabase.table("cashbox_transactions").insert(linha).execute()
        return avisos

    @staticmethod
    def _sessao_do_estorno(cashbox_id: str, da_venda: Optional[str]) -> Optional[str]:
        """Sessão a que o estorno se amarra quando o caixa está FECHADO.

        Preferência pela sessão que registrou a VENDA: é lá que o dinheiro
        entrou, e é lá que a devolução precisa aparecer para o par fechar. Sem
        nenhum lançamento da venda (venda anterior ao espelhamento), vale a
        última sessão do caixa — melhor no extrato da sessão errada do que fora
        do extrato.
        """
        if da_venda:
            return da_venda
        try:
            s = (
                supabase.table("cashbox_sessions").select("id")
                .eq("cashbox_id", cashbox_id)
                .order("opened_at", desc=True)
                .limit(1)
                .execute()
            )
            return s.data[0]["id"] if s.data else None
        except Exception:
            logger.warning(
                "Não foi possível achar a última sessão do caixa %s para amarrar o estorno",
                cashbox_id, exc_info=True,
            )
            return None

    @staticmethod
    def _desfazer_fidelidade(tx: dict, valor: float) -> List[str]:
        """Estorna os PONTOS e o CASHBACK creditados por esta venda.

        `trg_loyalty_earn` é INSERT-only e credita duas coisas diferentes:
          - pontos, com linha no loyalty_ledger;
          - cashback, que ATÉ a migração cancel_sale_idempotencia não era
            registrado em lugar nenhum — só o saldo em
            loyalty_accounts.cashback_balance. Daí em diante ele vem gravado em
            `loyalty_ledger.cashback_delta` e o estorno lê o valor exato; para
            as vendas antigas resta estimar (ver _cashback_da_venda).
        O cashback é dinheiro de verdade: `loyalty_convert_cashback` o transforma
        em crédito gastável no Caixa. Sem estorná-lo o clube paga duas vezes pela
        mesma venda — devolve o buy-in e ainda deixa o cashback com o jogador.

        Os pontos vitalícios também definem o NÍVEL (tier), que dá multiplicador
        de pontos e % de cashback maiores em TODAS as compras seguintes: baixar
        lifetime_points sem recalcular o tier deixaria o jogador VIP para sempre
        por uma compra que não existiu.

        Best-effort, como o próprio motor de ganho: um problema na fidelidade não
        pode impedir o estorno do DINHEIRO, que já aconteceu. Mas a falha agora
        vai para o log e volta como aviso — antes sumia num `except: pass`.
        """
        avisos: List[str] = []
        try:
            extrato = (
                supabase.table("loyalty_ledger")
                .select("*")
                .eq("transaction_id", tx["id"])
                .execute()
            )
            linhas = extrato.data or []
            # Retomada: esta venda já teve a fidelidade estornada. Quem prova
            # isso é o MOTIVO da linha (`cancel_...`), e não o sinal do delta:
            # no banco anterior à coluna `cashback_delta`, a venda que gerou só
            # cashback (pontos arredondam para zero em valores baixos) deixava
            # um recibo de delta ZERO — invisível para uma checagem por sinal,
            # e a retentativa debitava o cashback do jogador outra vez.
            if any(str(l.get("reason") or "").startswith("cancel_")
                   or float(l.get("delta") or 0) < 0
                   or float(l.get("cashback_delta") or 0) < 0
                   for l in linhas):
                return []
            pontos = sum(float(l.get("delta") or 0) for l in linhas)

            contas = (
                supabase.table("loyalty_accounts")
                .select("*")
                .eq("player_id", tx["player_id"])
                .execute()
            )
            if not contas.data:
                return []
            conta = contas.data[0]
            org = conta.get("organization_id") or tx.get("organization_id")

            dados = {"updated_at": datetime.now(timezone.utc).isoformat()}
            saldo = float(conta.get("points_balance") or 0)
            if pontos > 0:
                saldo = max(saldo - pontos, 0)
                vitalicio = max(float(conta.get("lifetime_points") or 0) - pontos, 0)
                dados["points_balance"] = saldo
                dados["lifetime_points"] = vitalicio
                nivel = TransactionService._nivel_para(org, vitalicio)
                if nivel is not None:
                    dados["tier_id"] = nivel

            cashback, alertas = TransactionService._cashback_da_venda(
                tx, conta, org, valor, linhas
            )
            avisos += alertas
            if cashback > 0:
                disponivel = float(conta.get("cashback_balance") or 0)
                # Piso em zero: nunca tirar do jogador mais do que ele tem.
                dados["cashback_balance"] = round(max(disponivel - cashback, 0), 2)
                if disponivel < cashback:
                    avisos.append(
                        f"O cashback de R$ {cashback:.2f} desta venda já tinha virado crédito do "
                        f"jogador: só R$ {disponivel:.2f} voltou. Ajuste o crédito dele manualmente."
                    )

            supabase.table("loyalty_accounts").update(dados).eq(
                "player_id", tx["player_id"]
            ).execute()

            if pontos > 0 or cashback > 0:
                # A linha de estorno é o que faz a retomada saber que a
                # fidelidade desta venda já foi desfeita — por isso ela existe
                # mesmo quando a venda só gerou cashback.
                recibo = {
                    "organization_id": org,
                    "player_id": tx["player_id"],
                    "delta": -pontos,
                    "balance_after": saldo,
                    "reason": f"cancel_{tx['type']}",
                    "transaction_id": tx["id"],
                    "description": "Estorno de venda cancelada",
                    "cashback_delta": -cashback,
                }
                try:
                    supabase.table("loyalty_ledger").insert(recibo).execute()
                except Exception:
                    # Schema anterior à coluna de cashback: grava sem ela, e
                    # AINDA ASSIM grava — mesmo com zero pontos. É esta linha
                    # que a retomada reconhece pelo `reason`; sem ela, a venda
                    # de valor baixo (cashback sim, pontos zero) teria o
                    # cashback debitado do jogador uma segunda vez.
                    logger.warning(
                        "loyalty_ledger ainda não tem cashback_delta; gravando o estorno sem ele",
                        exc_info=True,
                    )
                    recibo.pop("cashback_delta", None)
                    supabase.table("loyalty_ledger").insert(recibo).execute()
        except Exception:
            logger.exception(
                "Falha ao estornar a fidelidade da venda %s (jogador %s)",
                tx.get("id"), tx.get("player_id"),
            )
            avisos.append(
                "Não foi possível estornar os pontos/cashback de fidelidade desta venda — "
                "confira o programa de fidelidade do jogador."
            )
        return avisos

    @staticmethod
    def _cashback_da_venda(
        tx: dict, conta: dict, org: Optional[str], valor: float, extrato: List[dict]
    ) -> Tuple[float, List[str]]:
        """Quanto de cashback ESTA venda creditou — e só ela.

        Devolve (valor a estornar, avisos).

        Cashback é dinheiro: `loyalty_convert_cashback` o transforma em crédito
        gastável no Caixa. Debitar a mais tira do jogador um saldo que ele
        ganhou em OUTRAS compras, e ninguém percebe — não há extrato de
        cashback para conferir.

        Duas fontes, nesta ordem:

        1. O RECIBO (`loyalty_ledger.cashback_delta`, gravado pelo gatilho a
           partir de database_migration_cancel_sale_idempotencia.sql). É o valor
           exato daquela compra, com o percentual que valia NA HORA.
        2. Venda ANTERIOR ao recibo: só resta ESTIMAR por `valor * %`, e
           estimativa não tira dinheiro de ninguém — o valor volta como AVISO,
           com zero debitado. O percentual sairia do nível de HOJE: quem comprou
           como Bronze (0%) e subiu para Prata (1%) teria a venda antiga
           estornada a 1% de um cashback que ela nunca creditou. Errar a favor
           do jogador aqui custa centavos e o admin conserta em um clique;
           errar contra tira dinheiro real de quem não deve, e ninguém percebe
           porque não existe extrato de cashback para conferir. Depois da
           migração o valor exato está gravado e o estorno volta a debitar.
        """
        registrado = [l for l in extrato if l.get("cashback_delta") is not None]
        if registrado:
            exato = round(sum(float(l.get("cashback_delta") or 0) for l in registrado), 2)
            return max(exato, 0.0), []

        ganhou = TransactionService._venda_gerou_cashback(tx, org, extrato)
        if ganhou is False:
            # O gatilho de ganho não rodou para esta venda: não há cashback dela
            # para devolver. Debitar aqui seria confiscar o saldo que o jogador
            # acumulou em outras compras.
            return 0.0, []
        if ganhou is None:
            return 0.0, [
                "Não foi possível confirmar se esta venda gerou cashback (programa de "
                "fidelidade indisponível): nada foi debitado do saldo do jogador. "
                "Confira o cashback dele antes de fechar a noite."
            ]

        pct = None
        tier_id = conta.get("tier_id")
        if tier_id:
            t = supabase.table("loyalty_tiers").select("cashback_percent").eq("id", tier_id).execute()
            if t.data:
                pct = t.data[0].get("cashback_percent")
        if pct is None and org:
            s = (
                supabase.table("loyalty_settings").select("cashback_percent")
                .eq("organization_id", org).execute()
            )
            if s.data:
                pct = s.data[0].get("cashback_percent")
        estimado = round(valor * float(pct or 0) / 100.0, 2)
        if estimado <= 0:
            return 0.0, []
        return 0.0, [
            f"O cashback desta venda não foi registrado na época (venda antiga): NADA foi "
            f"debitado do saldo do jogador. Pelo nível ATUAL dele seriam cerca de "
            f"R$ {estimado:.2f} — se quiser retirar, ajuste o cashback dele no perfil."
        ]

    @staticmethod
    def _venda_gerou_cashback(tx: dict, org: Optional[str], extrato: List[dict]) -> Optional[bool]:
        """Esta venda passou pelo motor de ganho? True / False / None (não deu para saber).

        As três condições são as de `loyalty_earn_on_transaction`
        (database_migration_loyalty_phase2.sql): `org_has_loyalty` (plano PRO ou
        PREMIUM), `loyalty_settings.enabled`, e o tipo da venda dentro de
        `earn_on`. O estorno ignorava todas as três e debitava sempre.

        Linha de PONTOS no extrato desta venda é prova direta: o gatilho só
        grava depois de passar pelas três.
        """
        if any(float(l.get("delta") or 0) > 0 for l in extrato):
            return True
        if not org:
            return False
        try:
            o = supabase.table("organizations").select("plan_code").eq("id", org).execute()
            if not o.data:
                return False
            if (o.data[0].get("plan_code") or "") not in ("pro", "premium"):
                return False

            s = supabase.table("loyalty_settings").select("*").eq("organization_id", org).execute()
            if not s.data:
                return False
            cfg = s.data[0]
            if cfg.get("enabled", True) is False:
                return False
            tipos = cfg.get("earn_on")
            if tipos is None:
                # Schema anterior a `earn_on`: não dá para afirmar que a venda
                # gerou cashback, e chutar custa dinheiro do jogador.
                return None
            return tx.get("type") in tipos
        except Exception:
            logger.warning(
                "Não foi possível conferir as condições de ganho da fidelidade da venda %s",
                tx.get("id"), exc_info=True,
            )
            return None

    @staticmethod
    def _nivel_para(org: Optional[str], pontos_vitalicios: float) -> Optional[str]:
        """Nível correspondente ao total vitalício — mesma regra de
        `loyalty_tier_for` (o maior min_points que ainda cabe nos pontos)."""
        if not org:
            return None
        t = (
            supabase.table("loyalty_tiers").select("id, min_points")
            .eq("organization_id", org)
            .lte("min_points", pontos_vitalicios)
            .order("min_points", desc=True)
            .limit(1)
            .execute()
        )
        return t.data[0]["id"] if t.data else None

    @staticmethod
    def update_payment_method(
        transaction_id: str, payment_method: str, notes: Optional[str] = None
    ) -> TransactionDetail:
        """Troca só o RÓTULO da forma de pagamento (dinheiro/pix/cartão).

        Não move dinheiro: `amount`, `rake_amount`, `type` e `payment_source`
        ficam intactos. Serve para o operador corrigir "recebi no PIX, marquei
        dinheiro" sem precisar estornar e refazer a venda — o que mexeria em
        caixa, bolsa de prêmios e fidelidade à toa.
        """
        atual = supabase.table("transactions").select("*").eq("id", transaction_id).execute()
        if not atual.data:
            raise ErroDeNegocio(
                "transacao_nao_encontrada", "Transação não encontrada", status=404
            )
        # Vale também para a venda em 'cancelling': o dinheiro dela já está
        # voltando para o jogador, trocar o rótulo agora só confundiria a
        # conferência da gaveta por forma de pagamento.
        if (atual.data[0].get("status") or "active") != "active":
            raise ErroDeNegocio(
                "venda_cancelada_nao_alteravel", "Venda cancelada não pode ser alterada"
            )

        dados = {"payment_method": payment_method}
        if notes is not None:
            dados["notes"] = notes
        resp = supabase.table("transactions").update(dados).eq("id", transaction_id).execute()
        return TransactionService._detalhar(resp.data[0])

    @staticmethod
    def _detalhar(tx: dict) -> TransactionDetail:
        """Monta o TransactionDetail buscando os nomes de torneio e jogador."""
        limpa = {k: v for k, v in tx.items() if k not in ("tournaments", "players")}
        tournament = supabase.table("tournaments").select("name").eq("id", tx["tournament_id"]).execute()
        player = supabase.table("players").select(COLUNAS_JOGADOR).eq("id", tx["player_id"]).execute()
        pinfo = player.data[0] if player.data else {}
        return TransactionDetail(
            **limpa,
            tournament_name=tournament.data[0]["name"] if tournament.data else "",
            player_name=pinfo.get("name", ""),
            player_nickname=pinfo.get("nickname"),
        )

    @staticmethod
    def get_transactions(stage_id: Optional[str] = None) -> List[TransactionDetail]:
        """Get all transactions with details, optionally filtered by stage_id"""
        if stage_id:
            # Filter transactions by tournaments that belong to the stage
            response = (
                supabase.table("transactions")
                .select("*, tournaments!inner(name, stage_id), players(name, nickname)")
                .eq("tournaments.stage_id", stage_id)
                .order("created_at", desc=True)
                .execute()
            )
        else:
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

        # The player is fixed for this query — fetch their info ONCE instead of
        # re-querying the same row inside the loop (was N identical queries).
        player = supabase.table("players").select(COLUNAS_JOGADOR).eq("id", player_id).execute()
        player_info = player.data[0] if player.data else {}

        transactions = []
        for item in response.data:
            tournament = item.get("tournaments", {})
            trans_data = {k: v for k, v in item.items() if k != "tournaments"}

            transactions.append(TransactionDetail(
                **trans_data,
                tournament_name=tournament.get("name", ""),
                player_name=player_info.get("name", ""),
                player_nickname=player_info.get("nickname")
            ))

        return transactions
