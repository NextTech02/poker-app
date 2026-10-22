"""O dinheiro do cash game: sentar, recomprar, levantar e estornar.

TRÊS INVARIANTES QUE ESTE ARQUIVO PROTEGE:

1. **A cadeira é recurso físico disputado.** Dois caixas atendendo com a tela
   recarregando a cada 5s têm janela de sobra para sentar duas pessoas no mesmo
   lugar. A tomada do assento é um compare-and-set (`UPDATE ... WHERE
   status='free'`): quem perder a corrida recebe `assento_ocupado`, não uma
   segunda pessoa em pé na frente da mesa.

2. **O jogador não senta em duas mesas ao mesmo tempo.** Duas sessões ativas
   acumulariam buy-in em paralelo e o resultado da noite dele viraria ficção. O
   índice parcial no banco é a trava; aqui a recusa ganha nome.

3. **Estorno é lógico e RETOMÁVEL, nunca DELETE.** Os passos ficam gravados em
   `cancel_steps` e cada um é guardado pelo EFEITO no banco (o recibo do
   estorno existe?), não por um marcador. Sem isso, um estorno interrompido no
   meio — timeout, rede — vira permanente: a segunda tentativa veria "já
   cancelada" e responderia sucesso com o caixa inflado.
"""
import logging
import re
from datetime import datetime, timezone
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    CashPlayerSessionResponse,
    CashRebuy,
    CashSeatResponse,
    CashTransactionResponse,
    SitPlayer,
    SitPlayerResult,
    StandPlayer,
)
from app.services.cash_day_service import CashDayService
from app.services.cash_table_service import CashTableService
from app.services.cashbox_service import CashboxService
from app.services.house_credit_service import (
    PAYMENT_SOURCE as FIADO,
    HouseCreditService,
    recusa_do_banco,
)
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)


def _saldo_insuficiente(disponivel: float, solicitado: float) -> ErroDeNegocio:
    # Mesmo código da sangria (cashbox_service): a tela já traduz e formata
    # os números na moeda do clube.
    return ErroDeNegocio(
        "saldo_insuficiente_no_caixa",
        f"Saldo insuficiente no caixa — disponível {disponivel:.2f}",
        disponivel=round(disponivel, 2),
        solicitado=round(float(solicitado), 2),
    )


def _traduzir_erro_do_banco(exc: Exception) -> None:
    """O trigger da gaveta recusa com `REGRA_CAIXA:<code> disponivel=X
    solicitado=Y`, e os do fiado com `REGRA_FIADO:<code> ...`; viram a mesma
    recusa que o serviço daria. Qualquer outro erro sobe como veio."""
    fiado = recusa_do_banco(exc)
    if fiado:
        raise fiado from exc
    texto = str(exc)
    if "REGRA_CAIXA:saldo_insuficiente_no_caixa" in texto:
        disp = re.search(r"disponivel=(-?[\d.]+)", texto)
        sol = re.search(r"solicitado=(-?[\d.]+)", texto)
        raise _saldo_insuficiente(
            float(disp.group(1)) if disp else 0.0,
            float(sol.group(1)) if sol else 0.0,
        ) from exc
    raise exc

PASSO_CAIXA = "caixa_operador"
PASSO_MARCAR = "marcar_cancelada"


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


class CashTransactionService:

    # ============================================================
    # Idempotência
    # ============================================================

    @staticmethod
    def _por_mutation_id(client_mutation_id: Optional[str]) -> Optional[dict]:
        """A venda já gravada com este id, se houver.

        Duplo clique e retry acontecem com rede boa — e cobrar duas vezes pelo
        mesmo buy-in é o erro mais caro que o caixa comete.
        """
        if not client_mutation_id:
            return None
        resp = supabase.table("cash_transactions").select("*") \
            .eq("client_mutation_id", client_mutation_id).limit(1).execute()
        return resp.data[0] if resp.data else None

    # ============================================================
    # Sentar
    # ============================================================

    @staticmethod
    def sit(
        table_id: str,
        seat_number: int,
        data: SitPlayer,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> SitPlayerResult:
        repetida = CashTransactionService._por_mutation_id(data.client_mutation_id)
        if repetida:
            return CashTransactionService._resultado_de(repetida)

        mesa = CashTableService.get_table(table_id)
        if mesa.get("status") == "closed":
            raise ErroDeNegocio("mesa_ja_fechada", "Esta mesa já foi fechada.", status=409)
        CashDayService.require_open_day(mesa["cash_day_id"])
        caixa = CashboxService.require_open_cashbox_for_cash_day(
            auth_user_id, mesa["cash_day_id"]
        )

        CashTransactionService._validar_buy_in(mesa, data.buy_in_amount)

        org = organization_id or mesa.get("organization_id")
        fiado = data.payment_source == FIADO
        if fiado:
            # Antes de tomar a cadeira: recusar aqui não deixa nada para desfazer.
            HouseCreditService.exigir_disponivel(data.player_id, data.buy_in_amount, org)

        assento = CashTransactionService._assento(table_id, seat_number)
        if assento.get("status") == "occupied":
            raise ErroDeNegocio(
                "assento_ocupado", "Este lugar já está ocupado.",
                status=409, seat_number=seat_number,
            )
        if assento.get("status") == "blocked":
            raise ErroDeNegocio(
                "assento_indisponivel", "Este lugar está bloqueado.",
                status=409, seat_number=seat_number,
            )
        reservado_para = assento.get("reserved_for")
        if assento.get("status") == "reserved" and reservado_para and reservado_para != data.player_id:
            raise ErroDeNegocio(
                "assento_reservado",
                "Este lugar está reservado para outro jogador.",
                status=409, seat_number=seat_number,
            )

        # Recusa com NOME antes de esbarrar no índice do banco. A trava real é
        # o índice parcial (duas requisições simultâneas não passam pelo
        # pré-teste), mas quem chega sozinho merece a mensagem certa e não uma
        # violação de chave traduzida na marra.
        ja_sentado = (
            supabase.table("cash_player_sessions")
            .select("id, table_id")
            .eq("cash_day_id", mesa["cash_day_id"])
            .eq("player_id", data.player_id)
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        if ja_sentado.data:
            raise ErroDeNegocio(
                "jogador_ja_sentado",
                "Este jogador já está sentado em outra mesa hoje.",
                status=409,
                player_id=data.player_id,
                player_session_id=ja_sentado.data[0]["id"],
            )

        # 1) TOMAR A CADEIRA primeiro, em compare-and-set. É o único ponto onde
        #    duas requisições simultâneas podem colidir, e quem perde não pode
        #    ter deixado sessão nem venda para trás.
        tomada = supabase.table("cash_seats").update({
            "status": "occupied",
            "reserved_for": None,
            "reserved_until": None,
            "updated_at": _agora(),
        }).eq("id", assento["id"]).in_("status", ["free", "reserved"]).execute()
        if not tomada.data:
            raise ErroDeNegocio(
                "assento_ocupado",
                "Este lugar acabou de ser ocupado.",
                status=409, seat_number=seat_number,
            )

        try:
            sessao = CashTransactionService._criar_sessao(mesa, data, seat_number, org)
        except Exception:
            CashTransactionService._liberar_assento(assento["id"])
            raise

        try:
            venda = CashTransactionService._inserir(
                mesa=mesa, tipo="buy_in", amount=data.buy_in_amount,
                player_session_id=sessao["id"], player_id=data.player_id,
                # Fiado não é meio de pagamento nem dinheiro na gaveta: sem
                # método e sem gaveta (o banco também garante as duas coisas).
                payment_method=None if fiado else data.payment_method,
                payment_source=data.payment_source,
                client_mutation_id=data.client_mutation_id, notes=data.notes,
                auth_user_id=auth_user_id, organization_id=org,
                cashbox_id=None if fiado else (caixa or {}).get("id"),
            )
        except Exception:
            # Sessão sem venda é um jogador sentado sem ter pago: some com ela
            # e devolve a cadeira.
            supabase.table("cash_player_sessions").delete().eq("id", sessao["id"]).execute()
            CashTransactionService._liberar_assento(assento["id"])
            raise

        supabase.table("cash_seats").update({
            "player_session_id": sessao["id"], "updated_at": _agora(),
        }).eq("id", assento["id"]).execute()

        return CashTransactionService._resultado_de(venda)

    @staticmethod
    def _criar_sessao(mesa: dict, data: SitPlayer, seat_number: int, org: Optional[str]) -> dict:
        payload = {
            "cash_day_id": mesa["cash_day_id"],
            "table_id": mesa["id"],
            "player_id": data.player_id,
            "seat_number": seat_number,
            "status": "active",
            "notes": data.notes,
        }
        if org:
            payload["organization_id"] = org
        try:
            resp = supabase.table("cash_player_sessions").insert(payload).execute()
        except Exception as exc:
            if "duplicate key" in str(exc).lower() or "23505" in str(exc):
                raise ErroDeNegocio(
                    "jogador_ja_sentado",
                    "Este jogador já está sentado em outra mesa hoje.",
                    status=409, player_id=data.player_id,
                )
            raise
        return resp.data[0]

    @staticmethod
    def _liberar_assento(seat_id: str) -> None:
        supabase.table("cash_seats").update({
            "status": "free", "player_session_id": None, "updated_at": _agora(),
        }).eq("id", seat_id).execute()

    @staticmethod
    def _validar_buy_in(mesa: dict, valor: float) -> None:
        """Os limites são da MESA (o retrato feito na abertura), não da
        modalidade de hoje."""
        minimo = float(mesa.get("min_buy_in") or 0)
        maximo = mesa.get("max_buy_in")
        if minimo and valor < minimo:
            # Os números vão nomeados: a tela remonta a frase no idioma dela e
            # o operador vê quanto falta sem precisar abrir a configuração.
            raise ErroDeNegocio(
                "buy_in_abaixo_do_minimo",
                "O buy-in está abaixo do mínimo desta mesa.",
                minimo=minimo, solicitado=valor,
            )
        if maximo is not None and valor > float(maximo):
            raise ErroDeNegocio(
                "buy_in_acima_do_maximo",
                "O buy-in está acima do máximo desta mesa.",
                maximo=float(maximo), solicitado=valor,
            )

    @staticmethod
    def _assento(table_id: str, seat_number: int) -> dict:
        resp = supabase.table("cash_seats").select("*") \
            .eq("table_id", table_id).eq("seat_number", seat_number).limit(1).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "assento_invalido", "Este lugar não existe nesta mesa.",
                status=404, seat_number=seat_number,
            )
        return resp.data[0]

    # ============================================================
    # Recompra
    # ============================================================

    @staticmethod
    def rebuy(
        player_session_id: str,
        data: CashRebuy,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> CashTransactionResponse:
        repetida = CashTransactionService._por_mutation_id(data.client_mutation_id)
        if repetida:
            return CashTransactionService._enriquecer([repetida])[0]

        sessao = CashTransactionService._sessao_ativa(player_session_id)
        mesa = CashTableService.get_table(sessao["table_id"])
        CashDayService.require_open_day(mesa["cash_day_id"])
        caixa = CashboxService.require_open_cashbox_for_cash_day(
            auth_user_id, mesa["cash_day_id"]
        )

        org = organization_id or mesa.get("organization_id")
        fiado = data.payment_source == FIADO
        if fiado:
            HouseCreditService.exigir_disponivel(sessao["player_id"], data.amount, org)

        # O teto de buy-in NÃO se aplica à recompra: no cash ele limita quanto o
        # jogador põe NA MESA ao sentar, e a recompra é reposição de quem já
        # perdeu fichas. Validar aqui impediria o jogador de voltar ao teto.
        venda = CashTransactionService._inserir(
            mesa=mesa, tipo="rebuy", amount=data.amount,
            player_session_id=player_session_id, player_id=sessao["player_id"],
            payment_method=None if fiado else data.payment_method,
            payment_source=data.payment_source,
            client_mutation_id=data.client_mutation_id, notes=data.notes,
            auth_user_id=auth_user_id,
            organization_id=org,
            cashbox_id=None if fiado else (caixa or {}).get("id"),
        )
        return CashTransactionService._enriquecer([venda])[0]

    # ============================================================
    # Levantar
    # ============================================================

    @staticmethod
    def stand(
        player_session_id: str,
        data: StandPlayer,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> CashPlayerSessionResponse:
        repetida = CashTransactionService._por_mutation_id(data.client_mutation_id)
        if repetida:
            # O cash-out já foi gravado, mas a resposta pode ter se perdido
            # ANTES de a sessão fechar: o retry termina o serviço em vez de
            # deixar o jogador "sentado" com as fichas já pagas.
            CashTransactionService._encerrar_sessao(player_session_id)
            return CashTransactionService.get_player_session(player_session_id)

        sessao = CashTransactionService._sessao_ativa(player_session_id)
        mesa = CashTableService.get_table(sessao["table_id"])
        CashDayService.require_open_day(mesa["cash_day_id"])
        caixa = CashboxService.require_open_cashbox_for_cash_day(
            auth_user_id, mesa["cash_day_id"]
        )

        org = organization_id or mesa.get("organization_id")

        # Zero é válido: quem perdeu tudo levanta sem receber nada, e a sessão
        # precisa fechar do mesmo jeito. Só não vale gerar um lançamento de
        # valor zero — o banco recusa (amount > 0) e ele não significaria nada.
        if data.cash_out_amount > 0:
            abatido, proposto, motivo = CashTransactionService._abatimento_do_fiado(
                sessao["player_id"], data, org
            )
            liquido = round(data.cash_out_amount - abatido, 2)
            # A gaveta paga o cash-out em dinheiro vivo: não sai mais do que
            # entrou. Esta checagem dá a recusa com nome e os números; a trava
            # que resiste a dois levantes simultâneos é a do banco
            # (mirror_cash_transaction_to_cashbox, com FOR UPDATE na gaveta).
            # Com fiado, a gaveta só paga o LÍQUIDO: a parte abatida fica no
            # clube como quitação da dívida.
            if caixa is not None and liquido > 0:
                disponivel = float(caixa.get("current_balance") or 0)
                if liquido > disponivel:
                    raise _saldo_insuficiente(disponivel, liquido)
            # Colunas do fiado só quando há fiado: sem a migração aplicada elas
            # não existem, e mandá-las derrubaria todo cash-out.
            extras = None
            if proposto is not None:
                extras = {
                    "debt_settled_amount": abatido,
                    "debt_offset_expected": proposto,
                    "debt_offset_reason": motivo,
                }
            CashTransactionService._inserir(
                mesa=mesa, tipo="cash_out", amount=data.cash_out_amount,
                player_session_id=player_session_id, player_id=sessao["player_id"],
                payment_method=data.payment_method, payment_source=None,
                client_mutation_id=data.client_mutation_id, notes=data.notes,
                auth_user_id=auth_user_id, organization_id=org,
                cashbox_id=(caixa or {}).get("id"),
                extras=extras,
            )

        CashTransactionService._encerrar_sessao(player_session_id)
        return CashTransactionService.get_player_session(player_session_id)

    @staticmethod
    def _abatimento_do_fiado(player_id: str, data: StandPlayer, org: Optional[str]):
        """(abatido, proposto, motivo) do cash-out — a regra é a mesma do
        prêmio de torneio (HouseCreditService.calcular_abatimento)."""
        return HouseCreditService.calcular_abatimento(
            player_id, data.cash_out_amount, data.debt_offset_amount, data.debt_offset_reason, org,
        )

    @staticmethod
    def _encerrar_sessao(player_session_id: str) -> None:
        supabase.table("cash_player_sessions").update({
            "status": "left",
            "ended_at": _agora(),
        }).eq("id", player_session_id).eq("status", "active").execute()
        CashTransactionService._liberar_assento_da_sessao(player_session_id)

    @staticmethod
    def _liberar_assento_da_sessao(player_session_id: str) -> None:
        assentos = supabase.table("cash_seats").select("id") \
            .eq("player_session_id", player_session_id).execute().data or []
        for a in assentos:
            CashTransactionService._liberar_assento(a["id"])

    @staticmethod
    def _sessao_ativa(player_session_id: str) -> dict:
        resp = supabase.table("cash_player_sessions").select("*") \
            .eq("id", player_session_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "sessao_de_jogador_nao_encontrada",
                "Sessão do jogador não encontrada.", status=404,
            )
        sessao = resp.data[0]
        if sessao.get("status") != "active":
            raise ErroDeNegocio(
                "sessao_de_jogador_encerrada",
                "Este jogador já levantou da mesa.",
                status=409, status_atual=sessao.get("status"),
            )
        return sessao

    # ============================================================
    # Trocar de mesa
    # ============================================================

    @staticmethod
    def move(
        player_session_id: str,
        to_table_id: str,
        to_seat: int,
        auth_user_id: Optional[str] = None,
        organization_id: Optional[str] = None,
    ) -> CashPlayerSessionResponse:
        """Move o jogador para outra mesa SEM passar pelo caixa.

        O DINHEIRO NÃO SE MEXE: ele levou as fichas com ele. Tratar a troca como
        cash-out + buy-in inflaria o giro do dia com dinheiro que nunca passou
        pela gaveta, e a conferência do caixa acusaria uma entrada e uma saída
        que ninguém contou.

        A sessão antiga fecha encadeada na nova (`moved_to_id`): o resultado da
        noite do jogador soma a corrente inteira, e a mesa de origem mantém o
        histórico de quem passou por ela.
        """
        origem = CashTransactionService._sessao_ativa(player_session_id)
        destino = CashTableService.get_table(to_table_id)
        if destino.get("status") == "closed":
            raise ErroDeNegocio("mesa_ja_fechada", "A mesa de destino já foi fechada.", status=409)
        if destino["id"] == origem["table_id"] and to_seat == origem["seat_number"]:
            raise ErroDeNegocio(
                "mesa_de_destino_igual",
                "O jogador já está neste lugar.",
                status=409,
            )
        CashDayService.require_open_day(destino["cash_day_id"])

        assento = CashTransactionService._assento(to_table_id, to_seat)
        reservado_para = assento.get("reserved_for")
        if assento.get("status") == "reserved" and reservado_para and reservado_para != origem["player_id"]:
            raise ErroDeNegocio(
                "assento_reservado",
                "Este lugar está reservado para outro jogador.",
                status=409, seat_number=to_seat,
            )

        org = organization_id or destino.get("organization_id") or origem.get("organization_id")

        # Toma a cadeira de destino ANTES de mexer na origem: se a corrida for
        # perdida, o jogador continua exatamente onde estava.
        tomada = supabase.table("cash_seats").update({
            "status": "occupied", "reserved_for": None, "reserved_until": None,
            "updated_at": _agora(),
        }).eq("id", assento["id"]).in_("status", ["free", "reserved"]).execute()
        if not tomada.data:
            raise ErroDeNegocio(
                "assento_ocupado", "Este lugar acabou de ser ocupado.",
                status=409, seat_number=to_seat,
            )

        payload = {
            "cash_day_id": destino["cash_day_id"],
            "table_id": to_table_id,
            "player_id": origem["player_id"],
            "seat_number": to_seat,
            "status": "active",
            # Os totais VIAJAM com o jogador: as fichas foram com ele, e o
            # resultado da noite continua sendo cash-out menos buy-in.
            "total_buy_in": origem.get("total_buy_in") or 0,
            "total_cash_out": origem.get("total_cash_out") or 0,
            "result": origem.get("result") or 0,
            "notes": origem.get("notes"),
        }
        if org:
            payload["organization_id"] = org

        # A origem sai de 'active' PRIMEIRO: o índice parcial não deixa o mesmo
        # jogador ter duas sessões ativas no dia, e é essa trava que garante que
        # ninguém acumule buy-in em duas mesas ao mesmo tempo.
        supabase.table("cash_player_sessions").update({
            "status": "moved", "ended_at": _agora(),
            # Os totais ZERAM na origem porque as vendas viajam com o jogador
            # (logo abaixo). Deixá-los ali faria a mesa de origem continuar
            # somando dinheiro que já está noutra mesa — e o salão contaria o
            # mesmo buy-in duas vezes.
            "total_buy_in": 0, "total_cash_out": 0, "result": 0,
        }).eq("id", player_session_id).execute()

        try:
            nova = supabase.table("cash_player_sessions").insert(payload).execute().data[0]
        except Exception:
            # Desfaz: o jogador volta a estar sentado onde estava.
            supabase.table("cash_player_sessions").update({
                "status": "active", "ended_at": None,
            }).eq("id", player_session_id).execute()
            CashTransactionService._liberar_assento(assento["id"])
            raise

        supabase.table("cash_seats").update({
            "player_session_id": nova["id"], "updated_at": _agora(),
        }).eq("id", assento["id"]).execute()

        supabase.table("cash_player_sessions").update({
            "moved_to_id": nova["id"],
        }).eq("id", player_session_id).execute()

        # As vendas seguem a sessão nova: é onde o jogador está agora, e é por
        # ela que a mesa de destino soma o dinheiro em jogo.
        supabase.table("cash_transactions").update({
            "player_session_id": nova["id"], "table_id": to_table_id,
        }).eq("player_session_id", player_session_id).execute()

        CashTransactionService._liberar_assento_da_sessao(player_session_id)
        return CashTransactionService.get_player_session(nova["id"])

    # ============================================================
    # Inserção crua
    # ============================================================

    @staticmethod
    def _inserir(
        mesa: dict, tipo: str, amount: float,
        player_session_id: Optional[str], player_id: Optional[str],
        payment_method: Optional[str], payment_source: Optional[str],
        client_mutation_id: Optional[str], notes: Optional[str],
        auth_user_id: Optional[str], organization_id: Optional[str],
        cashbox_id: Optional[str] = None,
        extras: Optional[dict] = None,
    ) -> dict:
        payload = {
            "cash_day_id": mesa["cash_day_id"],
            "table_id": mesa["id"],
            "player_session_id": player_session_id,
            "player_id": player_id,
            "type": tipo,
            "amount": amount,
            "payment_method": payment_method,
            "payment_source": payment_source,
            "client_mutation_id": client_mutation_id,
            "notes": notes,
            "created_by": auth_user_id,
            "status": "active",
        }
        # A gaveta vem de quem chamou, que acabou de exigi-la aberta. O trigger
        # do banco continua como rede de segurança para linhas inseridas por
        # outro caminho — mas o estorno precisa deste campo para saber ONDE
        # devolver o dinheiro, e um nulo aqui deixaria o cancelamento sem
        # efeito no caixa.
        if cashbox_id:
            payload["cashbox_id"] = cashbox_id
        if organization_id:
            payload["organization_id"] = organization_id
        if extras:
            payload.update(extras)

        try:
            resp = supabase.table("cash_transactions").insert(payload).execute()
        except Exception as exc:
            # Corrida de duplo clique: a outra requisição gravou primeiro. O
            # certo é devolver a venda que existe, não um erro — a operação que
            # o caixa pediu aconteceu exatamente uma vez.
            if client_mutation_id and (
                "duplicate key" in str(exc).lower() or "23505" in str(exc)
            ):
                existente = CashTransactionService._por_mutation_id(client_mutation_id)
                if existente:
                    return existente
            _traduzir_erro_do_banco(exc)
        return resp.data[0]

    # ============================================================
    # Cancelamento (estorno lógico, retomável)
    # ============================================================

    @staticmethod
    def cancel(
        transaction_id: str, reason: str, auth_user_id: Optional[str] = None
    ) -> CashTransactionResponse:
        resp = supabase.table("cash_transactions").select("*").eq("id", transaction_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "venda_nao_encontrada", "Lançamento não encontrado.", status=404
            )
        venda = resp.data[0]

        if venda.get("type") not in ("buy_in", "rebuy"):
            # Cash-out errado se corrige com um lançamento novo, não com
            # estorno: desfazer uma SAÍDA exigiria o dinheiro de volta na
            # gaveta, e isso é uma entrada de verdade que alguém precisa contar.
            raise ErroDeNegocio(
                "cash_out_nao_cancelavel",
                "Só a compra de fichas pode ser estornada.",
                tipo=venda.get("type"),
            )
        if venda.get("status") == "cancelled":
            return CashTransactionService._enriquecer([venda])[0]

        passos = list(venda.get("cancel_steps") or [])
        if venda.get("status") != "cancelling":
            # Venda no FIADO: o reverso da dívida é lançado pelo banco NESTE
            # update (trg_cash_tx_fiado_estorno). Se a dívida já foi paga e não
            # cobre o estorno, o banco recusa e a venda continua ativa — nada
            # fica preso em 'cancelling'. Não há passo de gaveta: a venda fiada
            # nasce sem `cashbox_id`.
            try:
                supabase.table("cash_transactions").update({
                    "status": "cancelling",
                    "cancel_reason": reason,
                    "cancelled_by": auth_user_id,
                }).eq("id", transaction_id).execute()
            except Exception as exc:
                _traduzir_erro_do_banco(exc)

        # PASSO 1 — devolver o dinheiro na gaveta do operador.
        # A guarda é o EFEITO (o recibo existe no banco?), não o marcador: um
        # `cancel_steps` gravado antes do lançamento deixaria o estorno pela
        # metade parecendo completo.
        if venda.get("cashbox_id"):
            ja_estornado = supabase.table("cashbox_transactions").select("id") \
                .eq("cash_transaction_id", transaction_id).eq("type", "refund") \
                .limit(1).execute()
            if not ja_estornado.data:
                caixa = supabase.table("cashboxes").select("current_session_id") \
                    .eq("id", venda["cashbox_id"]).execute()
                sessao_caixa = (caixa.data or [{}])[0].get("current_session_id")
                supabase.table("cashbox_transactions").insert({
                    "cashbox_id": venda["cashbox_id"],
                    "session_id": sessao_caixa,
                    "type": "refund",
                    "amount": venda["amount"],
                    "signed_amount": -abs(float(venda["amount"])),
                    "cash_transaction_id": transaction_id,
                    "performed_by": auth_user_id,
                    "notes": f"Estorno de cash game: {reason}",
                    "organization_id": venda.get("organization_id"),
                }).execute()
        if PASSO_CAIXA not in passos:
            passos.append(PASSO_CAIXA)

        # PASSO 2 — marcar. Por último: enquanto não estiver 'cancelled', uma
        # retentativa refaz o que faltou.
        if PASSO_MARCAR not in passos:
            passos.append(PASSO_MARCAR)
        final = supabase.table("cash_transactions").update({
            "status": "cancelled",
            "cancelled_at": _agora(),
            "cancelled_by": auth_user_id,
            "cancel_reason": reason,
            "cancel_steps": passos,
        }).eq("id", transaction_id).execute()

        return CashTransactionService._enriquecer(final.data)[0]

    # ============================================================
    # Leitura
    # ============================================================

    @staticmethod
    def list_transactions(
        cash_day_id: Optional[str] = None,
        table_id: Optional[str] = None,
        player_id: Optional[str] = None,
        player_session_id: Optional[str] = None,
        tipo: Optional[str] = None,
        limit: int = 200,
    ) -> List[CashTransactionResponse]:
        query = supabase.table("cash_transactions").select("*")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        if table_id:
            query = query.eq("table_id", table_id)
        if player_id:
            query = query.eq("player_id", player_id)
        if player_session_id:
            query = query.eq("player_session_id", player_session_id)
        if tipo:
            query = query.eq("type", tipo)
        linhas = query.order("created_at", desc=True).limit(limit).execute().data or []
        return CashTransactionService._enriquecer(linhas)

    @staticmethod
    def list_player_sessions(
        cash_day_id: Optional[str] = None,
        table_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[CashPlayerSessionResponse]:
        query = supabase.table("cash_player_sessions").select("*")
        if cash_day_id:
            query = query.eq("cash_day_id", cash_day_id)
        if table_id:
            query = query.eq("table_id", table_id)
        if status:
            query = query.eq("status", status)
        linhas = query.order("started_at", desc=True).execute().data or []
        return CashTransactionService._enriquecer_sessoes(linhas)

    @staticmethod
    def get_player_session(player_session_id: str) -> CashPlayerSessionResponse:
        resp = supabase.table("cash_player_sessions").select("*") \
            .eq("id", player_session_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "sessao_de_jogador_nao_encontrada",
                "Sessão do jogador não encontrada.", status=404,
            )
        return CashTransactionService._enriquecer_sessoes(resp.data)[0]

    # ============================================================
    # Enriquecimento (nomes, em consulta única)
    # ============================================================

    @staticmethod
    def _nomes_de_jogadores(ids: List[str]) -> dict:
        ids = [i for i in ids if i]
        if not ids:
            return {}
        linhas = supabase.table("players").select("id, name, nickname") \
            .in_("id", list(set(ids))).execute().data or []
        return {r["id"]: (r.get("nickname") or r.get("name")) for r in linhas}

    @staticmethod
    def _numeros_de_mesas(ids: List[str]) -> dict:
        ids = [i for i in ids if i]
        if not ids:
            return {}
        linhas = supabase.table("cash_tables").select("id, table_number") \
            .in_("id", list(set(ids))).execute().data or []
        return {r["id"]: r.get("table_number") for r in linhas}

    @staticmethod
    def _enriquecer(linhas: List[dict]) -> List[CashTransactionResponse]:
        if not linhas:
            return []
        nomes = CashTransactionService._nomes_de_jogadores([l.get("player_id") for l in linhas])
        mesas = CashTransactionService._numeros_de_mesas([l.get("table_id") for l in linhas])
        return [
            CashTransactionResponse(
                **l,
                player_name=nomes.get(l.get("player_id")),
                table_number=mesas.get(l.get("table_id")),
            )
            for l in linhas
        ]

    @staticmethod
    def _enriquecer_sessoes(linhas: List[dict]) -> List[CashPlayerSessionResponse]:
        if not linhas:
            return []
        nomes = CashTransactionService._nomes_de_jogadores([l.get("player_id") for l in linhas])
        mesas = CashTransactionService._numeros_de_mesas([l.get("table_id") for l in linhas])
        return [
            CashPlayerSessionResponse(
                **l,
                player_name=nomes.get(l.get("player_id")),
                table_number=mesas.get(l.get("table_id")),
            )
            for l in linhas
        ]

    @staticmethod
    def _resultado_de(venda: dict) -> SitPlayerResult:
        sessao = CashTransactionService.get_player_session(venda["player_session_id"])
        assentos = supabase.table("cash_seats").select("*") \
            .eq("player_session_id", venda["player_session_id"]).limit(1).execute()
        assento = assentos.data[0] if assentos.data else None
        return SitPlayerResult(
            player_session=sessao,
            transaction=CashTransactionService._enriquecer([venda])[0],
            seat=CashSeatResponse(**assento) if assento else CashSeatResponse(
                id="", table_id=venda.get("table_id") or "",
                seat_number=sessao.seat_number, status="occupied",
            ),
        )
