from fastapi import APIRouter, Depends, status
from typing import List, Optional
from app.models.tournament import (
    TournamentCreate,
    TournamentUpdate,
    Tournament,
    TournamentSummary,
    TournamentDeleteImpact,
    TournamentCancelAndDelete,
    TournamentCancelAndDeleteResult,
)
from app.models.buy_type import BuyTypesReplace
from app.services.buy_type_service import BuyTypeService
from app.services.tournament_service import (
    TournamentService,
    MovimentoFinanceiroImpedeExclusao,
)
from app.auth.jwt import get_current_user
from app.dependencies import get_stage_id_optional
from app.services.cashbox_service import CashboxService
# Recusas com CODIGO: a tela escolhe a frase no idioma do clube
# (Brasil, Peru, Colombia) — ver app/utils/erros.py.
from app.utils.erros import conflito, da_excecao, nao_encontrado, recusado, sem_permissao

router = APIRouter(prefix="/tournaments", tags=["tournaments"])


def _exigir_torneio_da_etapa(tournament_id: str, stage_id: Optional[str]) -> None:
    """Confere que o torneio existe e pertence à etapa selecionada.

    Sem o header não há o que conferir: a chamada segue e quem responde 404 é o
    próprio service, como sempre foi."""
    if not stage_id:
        return
    existente = TournamentService.get_tournament(tournament_id)
    if not existente:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    if existente.stage_id != stage_id:
        # Frase de DESENVOLVEDOR (o X-Stage-ID vem do proprio cliente, o
        # operador nao digita etapa): fica em ingles — a tela usa o codigo.
        raise sem_permissao(
            "torneio_fora_da_etapa",
            "Tournament does not belong to the selected stage",
        )


@router.post("", response_model=Tournament, status_code=status.HTTP_201_CREATED)
def create_tournament(
    tournament: TournamentCreate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """Create a new tournament. A stage (etapa) is mandatory: it comes from the
    X-Stage-ID header (preferred) or the request body, and must reference an
    existing stage."""
    user_id = current_user.get("sub")

    # Stage is required: never allow creating a tournament without an etapa.
    # The header takes precedence; fall back to a stage_id supplied in the body.
    effective_stage_id = stage_id or tournament.stage_id
    if not effective_stage_id:
        raise recusado(
            "etapa_obrigatoria",
            "É necessário selecionar uma etapa antes de criar um torneio.",
        )

    tournament.stage_id = effective_stage_id

    # Validate stage exists
    from app.database.supabase_client import supabase
    stage_response = supabase.table('stages').select('id').eq('id', effective_stage_id).execute()
    if not stage_response.data:
        # O id vai TAMBEM como dado nomeado, para a tela montar a frase no
        # idioma dela sem perder QUAL etapa nao existe.
        raise nao_encontrado(
            "etapa_nao_encontrada",
            f"Stage with id {effective_stage_id} not found",
            stage_id=effective_stage_id,
        )

    try:
        return TournamentService.create_tournament(tournament, user_id)
    except ValueError as e:
        # Configuração de KO recusada (modo em massa, classificatórios...).
        raise da_excecao(e)


@router.get("", response_model=List[TournamentSummary])
def get_tournaments(
    stage_id: Optional[str] = None,
    header_stage_id: Optional[str] = Depends(get_stage_id_optional),
    current_user: dict = Depends(get_current_user),
):
    """
    Get all tournaments with aggregated entries from non-final days.
    If X-Stage-ID header is present, it takes precedence over stage_id query parameter.

    Requires authentication: this lists every tournament across stages and is
    only used by the authenticated operator UI. The public broadcast view reads
    a single tournament via GET /tournaments/{id}, which stays open by design.
    """
    effective_stage_id = header_stage_id if header_stage_id else stage_id
    return TournamentService.get_tournament_summary(stage_id=effective_stage_id)


@router.get("/{tournament_id}", response_model=Tournament)
def get_tournament(tournament_id: str):
    """Get a specific tournament by ID"""
    tournament = TournamentService.get_tournament(tournament_id)
    if not tournament:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    return tournament


@router.get("/{tournament_id}/delete-impact", response_model=TournamentDeleteImpact)
def get_tournament_delete_impact(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """O que a exclusão deste torneio destruiria, com números reais.

    A tela chama isto ANTES de perguntar "tem certeza?": o operador precisa ler
    quantas entradas, quantos jogadores e quanto dinheiro somem com o clique.
    Exige autenticação — expõe faturamento."""
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    impacto = TournamentService.get_delete_impact(tournament_id)
    if impacto is None:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    return impacto


@router.patch("/{tournament_id}", response_model=Tournament)
def update_tournament(
    tournament_id: str,
    tournament_data: TournamentUpdate,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Update a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.
    """
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    try:
        tournament = TournamentService.update_tournament(tournament_id, tournament_data)
    except ValueError as e:
        # Troca para "por mesa" com eliminações em massa já lançadas (409).
        raise da_excecao(e)
    if not tournament:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    return tournament


@router.delete(
    "/{tournament_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        409: {
            "description": (
                "O torneio tem movimento financeiro (entradas vendidas, jogador "
                "pago ou premiação paga) e a exclusão foi recusada. O corpo traz "
                "`impact` com os números do que seria destruído."
            )
        },
    },
)
def delete_tournament(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """
    Delete a tournament.
    If X-Stage-ID header is present, validates that tournament belongs to that stage.

    Torneio com dinheiro em cima é RECUSADO aqui, no servidor, e não só na tela:
    quem chama a API direto (curl, script, integração) não pode contornar uma
    cascata que apaga venda, caixa e histórico de quem pagou.
    """
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    try:
        success = TournamentService.delete_tournament(tournament_id)
    except MovimentoFinanceiroImpedeExclusao as recusa:
        # `impact` continua no corpo (a tela repete os numeros na recusa); o
        # `code` entra ao lado para ela traduzir a frase.
        raise conflito(
            "torneio_com_movimento_financeiro",
            recusa.mensagem,
            impact=recusa.impacto.model_dump(),
        )
    if not success:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")


@router.post(
    "/{tournament_id}/cancel-sales-and-delete",
    response_model=TournamentCancelAndDeleteResult,
    responses={
        400: {"description": "O nome digitado não é o do torneio."},
        403: {"description": "Só quem administra o caixa pode estornar as vendas."},
        404: {"description": "Torneio não encontrado."},
        409: {
            "description": (
                "Sobra o que o estorno não desfaz (prêmio pago, venda com crédito "
                "ou ticket, satélite, crédito de patrocinador) — o corpo traz "
                "`impact` —, ou um estorno parou no meio (`estorno_em_massa_interrompido`)."
            )
        },
    },
)
def cancel_sales_and_delete_tournament(
    tournament_id: str,
    data: TournamentCancelAndDelete,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional),
):
    """Torneio criado por engano: estorna TODAS as vendas e exclui.

    Cada venda passa pelo estorno do Caixa (gaveta, caixa da etapa, contadores,
    fidelidade). Roda em rodadas: `deleted` falso com `remaining` > 0 quer dizer
    "chame de novo". Mesma permissão do estorno de venda: admin de caixa.
    """
    user_id = current_user.get("sub")
    if not CashboxService.can_admin(user_id):
        raise sem_permissao(
            "sem_permissao_excluir_com_vendas",
            "Só quem administra o caixa pode estornar as vendas e excluir o torneio",
        )
    _exigir_torneio_da_etapa(tournament_id, stage_id)

    try:
        resultado = TournamentService.cancel_sales_and_delete(
            tournament_id, user_id, data.reason.strip(), data.confirm_name
        )
    except MovimentoFinanceiroImpedeExclusao as recusa:
        raise conflito(
            "torneio_nao_estornavel",
            recusa.mensagem,
            impact=recusa.impacto.model_dump(),
        )
    except ValueError as e:
        raise da_excecao(e)
    if resultado is None:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    return resultado


# ── Meios de entrada do torneio ─────────────────────────────────────────────
# O que o torneio vende: nome, categoria, valor, rake e fichas. A lista é UMA
# por torneio e vale para todos os seus dias; por isso mora aqui, e não no
# router do dia.

def _torneio_da_etapa(tournament_id: str, stage_id: Optional[str]) -> Tournament:
    """O torneio existe e, havendo header, pertence à etapa selecionada.

    Diferente de `_exigir_torneio_da_etapa`, confere a existência SEMPRE: os
    meios de entrada não têm um service que responda 404 por eles."""
    existente = TournamentService.get_tournament(tournament_id)
    if not existente:
        raise nao_encontrado("torneio_nao_encontrado", "Tournament not found")
    if stage_id and existente.stage_id != stage_id:
        # Frase de DESENVOLVEDOR (o X-Stage-ID vem do proprio cliente, o
        # operador nao digita etapa): fica em ingles — a tela usa o codigo.
        raise sem_permissao(
            "torneio_fora_da_etapa",
            "Tournament does not belong to the selected stage",
        )
    return existente


@router.get("/{tournament_id}/buy-types")
def list_tournament_buy_types(
    tournament_id: str,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """Lista os meios de entrada do torneio, na ordem de exibição do Caixa."""
    _torneio_da_etapa(tournament_id, stage_id)
    return BuyTypeService.listar(tournament_id)


@router.put(
    "/{tournament_id}/buy-types",
    responses={
        400: {
            "description": (
                "Lista recusada: nenhum meio de entrada ativo na categoria buy-in, "
                "ou um id enviado que pertence a outro torneio."
            )
        },
        403: {"description": "O torneio pertence a outra etapa que não a do header X-Stage-ID."},
        404: {"description": "Torneio não encontrado."},
    },
)
def replace_tournament_buy_types(
    tournament_id: str,
    data: BuyTypesReplace,
    current_user: dict = Depends(get_current_user),
    stage_id: Optional[str] = Depends(get_stage_id_optional)
):
    """SUBSTITUI a lista inteira de meios de entrada do torneio.

    A tela edita tudo de uma vez; uma chamada por linha deixaria o torneio com
    metade da configuração nova se o operador fechasse o navegador no meio.

    O que sumiu da lista só é apagado quando nunca foi vendido — com venda, ele
    é desativado, senão o recibo perderia o rótulo do que a pessoa comprou.
    """
    _torneio_da_etapa(tournament_id, stage_id)

    try:
        return BuyTypeService.substituir(
            tournament_id, [item.model_dump() for item in data.items]
        )
    except ValueError as e:
        raise da_excecao(e, "meios_de_entrada_recusados")
