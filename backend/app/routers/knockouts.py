"""Premiação por eliminação (KO fixo, PKO, Mystery): resumo, pagar, corrigir,
encerrar e a fase Mystery.

O registro do KO acontece na eliminação (`POST /tournament-players/{id}/eliminate`,
com `eliminated_by`); aqui ficam as ações do CAIXA e do floor sobre o que já
foi registrado. Recusas vão com código (ver app/utils/erros.py).
"""
from fastapi import APIRouter, Depends

from app.auth import get_current_user
from app.models.knockout import (
    EliminatorsUpdate,
    EnvelopeExchangeRequest,
    KnockoutBatchPayRequest,
    KnockoutCloseRequest,
    KnockoutManualRequest,
    KnockoutOut,
    KnockoutPayRequest,
    KnockoutSummary,
    MysteryStartRequest,
)
from app.services.knockout_service import KnockoutService
from app.utils.erros import da_excecao

router = APIRouter(prefix="/tournaments", tags=["knockouts"])


@router.get("/{tournament_id}/knockouts/summary", response_model=KnockoutSummary)
def resumo(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Pozo KO, bounties atuais, eliminações e pagamentos (pendentes e pagos)."""
    return KnockoutService.resumo(tournament_id)


@router.post("/{tournament_id}/knockouts/payouts/{payout_id}/pay", response_model=KnockoutOut)
def pagar(
    tournament_id: str,
    payout_id: str,
    body: KnockoutPayRequest = KnockoutPayRequest(),
    current_user: dict = Depends(get_current_user),
):
    """Paga um prêmio de KO do caixa geral."""
    try:
        return KnockoutService.pagar(tournament_id, payout_id, current_user.get("sub"), body.paid_by)
    except ValueError as e:
        raise da_excecao(e, "pagamento_de_ko_recusado")


@router.post("/{tournament_id}/knockouts/payouts/pay-batch", response_model=list[KnockoutOut])
def pagar_lote(
    tournament_id: str,
    body: KnockoutBatchPayRequest,
    current_user: dict = Depends(get_current_user),
):
    """Paga vários prêmios de KO de uma vez; para no primeiro recusado."""
    try:
        return KnockoutService.pagar_lote(tournament_id, body.payout_ids, current_user.get("sub"), body.paid_by)
    except ValueError as e:
        raise da_excecao(e, "pagamento_de_ko_recusado")


@router.patch("/{tournament_id}/knockouts/{knockout_id}/eliminators", response_model=KnockoutOut)
def corrigir_eliminadores(
    tournament_id: str,
    knockout_id: str,
    body: EliminatorsUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Troca quem eliminou (enquanto nada daquele KO foi pago)."""
    try:
        return KnockoutService.corrigir_eliminadores(
            tournament_id, knockout_id, body.eliminated_by, body.no_eliminator,
        )
    except ValueError as e:
        raise da_excecao(e, "correcao_de_ko_recusada")


@router.post("/{tournament_id}/knockouts/close", response_model=KnockoutSummary)
def encerrar(
    tournament_id: str,
    body: KnockoutCloseRequest,
    current_user: dict = Depends(get_current_user),
):
    """Encerra os bounties: cada vivo leva o próprio; sem autor e sobras vão ao campeão."""
    try:
        return KnockoutService.encerrar(tournament_id, body.champion_tp_id, current_user.get("sub"))
    except ValueError as e:
        raise da_excecao(e, "encerramento_de_ko_recusado")


@router.delete("/{tournament_id}/knockouts/close", response_model=KnockoutSummary)
def desfazer_encerramento(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Desfaz o encerramento, se nada dele foi pago."""
    try:
        return KnockoutService.desfazer_encerramento(tournament_id, current_user.get("sub"))
    except ValueError as e:
        raise da_excecao(e, "encerramento_de_ko_recusado")


@router.post("/{tournament_id}/knockouts/{knockout_id}/envelope", response_model=KnockoutOut)
def trocar_envelope(
    tournament_id: str,
    knockout_id: str,
    body: EnvelopeExchangeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Sorteio físico: registra o envelope que o jogador tirou com o comprovante."""
    try:
        return KnockoutService.trocar_envelope(tournament_id, knockout_id, body.value, current_user.get("sub"))
    except ValueError as e:
        raise da_excecao(e, "troca_de_envelope_recusada")


@router.post("/{tournament_id}/knockouts/manual", response_model=KnockoutOut)
def registrar_manual(
    tournament_id: str,
    body: KnockoutManualRequest,
    current_user: dict = Depends(get_current_user),
):
    """Registra um prêmio Mystery entregue na mesa (envelope aberto fora do
    sistema). Fica pendente para o caixa pagar."""
    try:
        return KnockoutService.registrar_manual(
            tournament_id, body.recipient_tp_id, body.value, body.eliminated_tp_id, current_user.get("sub"),
        )
    except ValueError as e:
        raise da_excecao(e, "premio_manual_recusado")


@router.delete("/{tournament_id}/knockouts/manual/{knockout_id}", response_model=KnockoutSummary)
def desfazer_manual(tournament_id: str, knockout_id: str, current_user: dict = Depends(get_current_user)):
    """Desfaz um prêmio registrado à mão, se ainda não foi pago."""
    try:
        return KnockoutService.desfazer_manual(tournament_id, knockout_id, current_user.get("sub"))
    except ValueError as e:
        raise da_excecao(e, "premio_manual_recusado")


@router.post("/{tournament_id}/mystery/start", response_model=KnockoutSummary)
def iniciar_mystery(
    tournament_id: str,
    body: MysteryStartRequest,
    current_user: dict = Depends(get_current_user),
):
    """Congela o pozo KO em envelopes (um por jogador vivo, somando o pozo)."""
    try:
        return KnockoutService.iniciar_mystery(
            tournament_id,
            [{"value": e.value, "quantity": e.quantity} for e in body.envelopes],
            body.day_id,
            body.draw_mode,
        )
    except ValueError as e:
        raise da_excecao(e, "fase_mystery_recusada")


@router.delete("/{tournament_id}/mystery/start", response_model=KnockoutSummary)
def desfazer_mystery(tournament_id: str, current_user: dict = Depends(get_current_user)):
    """Desfaz o início da fase, se nenhum envelope foi sorteado."""
    try:
        return KnockoutService.desfazer_mystery(tournament_id)
    except ValueError as e:
        raise da_excecao(e, "fase_mystery_recusada")
