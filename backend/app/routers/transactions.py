from fastapi import APIRouter, Depends, HTTPException, status
from typing import List, Optional
from app.models.transaction import (
    TransactionCreate,
    TransactionDetail,
    TransactionCancel,
    TransactionPaymentMethodUpdate,
)
from app.services.transaction_service import TransactionService
from app.services.tournament_service import TournamentService
from app.services.cashbox_service import CashboxService
from app.services.sales_block_service import SalesBlockService
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional

router = APIRouter(prefix="/transactions", tags=["transactions"])


@router.post("", response_model=TransactionDetail, status_code=status.HTTP_201_CREATED)
def create_transaction(
    transaction: TransactionCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Create a new transaction (buy-in, rebuy, addon, prize).
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    user_id = current_user.get("sub")

    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        tournament = TournamentService.get_tournament(transaction.tournament_id)
        if not tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Cannot create transaction: tournament does not belong to the selected stage"
            )

    try:
        # Trava de vendas do DIA — e SÓ do dia. A ETAPA é checada dentro de
        # `create_transaction` (uma vez, para todos os chamadores); repetir aqui
        # era a mesma consulta duas vezes na rota que mais roda no evento.
        #
        # O dia precisa ser checado aqui porque esta rota não recebe
        # `tournament_day_id` no corpo: quem sabe o dia é a inscrição do
        # jogador. Sem isto, com o Dia 1A encerrado a venda entraria por aqui e
        # os triggers moveriam caixa, prize pool e fidelidade — o diretor acha
        # que fechou o registro tardio e o dinheiro continua entrando por fora.
        SalesBlockService.assert_day_sales_allowed(
            transaction.tournament_id, transaction.player_id, transaction.type
        )
        return TransactionService.create_transaction(transaction, user_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=List[TransactionDetail])
def get_transactions(
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get all transactions.
    If X-Stage-ID header is present, returns only transactions from tournaments in that stage.
    """
    return TransactionService.get_transactions(stage_id=stage_id)


@router.get("/tournament/{tournament_id}", response_model=List[TransactionDetail])
def get_tournament_transactions(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Get transactions for a specific tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    # Validate tournament belongs to stage if stage_id is provided
    if stage_id:
        tournament = TournamentService.get_tournament(tournament_id)
        if not tournament:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tournament not found"
            )
        if tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Tournament does not belong to the selected stage"
            )

    return TransactionService.get_transactions_by_tournament(tournament_id)


def _validar_escopo_da_etapa(transaction_id: str, stage_id: Optional[str]) -> dict:
    """Impede mexer numa venda de OUTRA etapa que não a selecionada no header.

    Mesma regra do POST desta rota: sem isso, um operador com a etapa A aberta
    conseguiria cancelar a venda da etapa B pelo id.
    """
    tx = TransactionService.get_raw_transaction(transaction_id)
    if not tx:
        raise HTTPException(status_code=404, detail="Transação não encontrada")
    if stage_id:
        tournament = TournamentService.get_tournament(tx["tournament_id"])
        if not tournament or tournament.stage_id != stage_id:
            raise HTTPException(
                status_code=403,
                detail="Transação não pertence à etapa selecionada",
            )
    return tx


@router.post("/{transaction_id}/cancel", response_model=TransactionDetail)
def cancel_transaction(
    transaction_id: str,
    data: TransactionCancel,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional),
):
    """Cancela uma venda (estorno lógico) e desfaz caixa, contadores e pontos.

    Só admin de caixa: o estorno mexe no caixa da etapa, no caixa do operador,
    na bolsa de prêmios e no rake da sangria — não é operação de balcão.
    """
    user_id = current_user.get("sub")
    if not CashboxService.can_admin(user_id):
        raise HTTPException(status_code=403, detail="Sem permissão para cancelar vendas")

    _validar_escopo_da_etapa(transaction_id, stage_id)
    try:
        return TransactionService.cancel_transaction(transaction_id, user_id, data.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/{transaction_id}/payment-method", response_model=TransactionDetail)
def update_transaction_payment_method(
    transaction_id: str,
    data: TransactionPaymentMethodUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional),
):
    """Corrige a forma de pagamento de uma venda (não move dinheiro).

    O próprio operador que registrou pode corrigir; qualquer outra pessoa
    precisa ser admin de caixa.
    """
    user_id = current_user.get("sub")
    tx = _validar_escopo_da_etapa(transaction_id, stage_id)

    if tx.get("created_by") != user_id and not CashboxService.can_admin(user_id):
        raise HTTPException(
            status_code=403,
            detail="Só o operador que registrou a venda ou um admin pode trocar a forma de pagamento",
        )

    try:
        return TransactionService.update_payment_method(
            transaction_id, data.payment_method, data.notes
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/player/{player_id}", response_model=List[TransactionDetail])
def get_player_transactions(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get transactions for a specific player"""
    return TransactionService.get_transactions_by_player(player_id)
