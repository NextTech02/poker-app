from fastapi import APIRouter, Depends, status, Query
from typing import List, Optional
from app.models.player import (
    PlayerCreate,
    PlayerUpdate,
    Player,
    PlayerStats,
    PlayerHistoryEntry,
)
from app.models.satellite_ticket import TicketResponse
from app.services.player_service import PlayerService
from app.services.player_consent_service import PlayerConsentService
from app.services.player_import_service import PlayerImportService
from app.services.satellite_ticket_service import SatelliteTicketService
from app.auth.jwt import get_current_user
from app.utils.erros import conflito, da_excecao, nao_encontrado, sem_permissao
from pydantic import BaseModel, Field

router = APIRouter(prefix="/players", tags=["players"])


# ── Importação de outro sistema (ex.: Poker Web) ─────────────────────────────
# O navegador lê a planilha e manda as linhas já em colunas nomeadas; a
# validação é toda no servidor. Rotas literais ANTES de /{player_id}.

class ImportRow(BaseModel):
    source_id: Optional[str] = None
    name: Optional[str] = None
    nickname: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    mobile: Optional[str] = None
    nationality: Optional[str] = None
    doc_country: Optional[str] = None
    document_type: Optional[str] = None
    document_number: Optional[str] = None
    birth_date: Optional[str] = None


class ImportRequest(BaseModel):
    rows: List[ImportRow] = Field(..., max_length=5000)


def _org(current_user: dict) -> str:
    org = current_user.get("organization_id")
    if not org:
        raise sem_permissao(
            "conta_sem_organizacao",
            "Sua conta não está vinculada a nenhuma organização.",
        )
    return org


@router.post("/import/preview")
def preview_import(data: ImportRequest, current_user: dict = Depends(get_current_user)):
    """Confere o arquivo e devolve o resumo, SEM gravar nada."""
    return PlayerImportService.analisar(
        _org(current_user), [r.model_dump() for r in data.rows]
    )


@router.post("/import")
def run_import(data: ImportRequest, current_user: dict = Depends(get_current_user)):
    """Grava os jogadores novos do arquivo."""
    try:
        return PlayerImportService.importar(
            _org(current_user), [r.model_dump() for r in data.rows]
        )
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("PLANO_LIMITE_CLIENTES:"):
            # O detalhe (quantos cabem, quantos já existem) vai TAMBÉM como dado
            # nomeado: a tela remonta a frase no idioma dela e mesmo assim mostra
            # os números, que é o que diz ao clube quanto falta liberar.
            detalhe = msg.split(":", 1)[1].strip()
            raise conflito("limite_de_clientes_do_plano", detalhe, detalhe=detalhe)
        raise da_excecao(exc)


@router.post("", response_model=Player, status_code=status.HTTP_201_CREATED)
def create_player(
    player: PlayerCreate,
    current_user: dict = Depends(get_current_user)
):
    """Create a new player"""
    return PlayerService.create_player(player)


@router.get("", response_model=List[Player])
def get_players(
    search: Optional[str] = Query(None, description="Search by name or nickname"),
    current_user: dict = Depends(get_current_user)
):
    """Get all players, optionally filtered by search term"""
    return PlayerService.get_players(search)


@router.get("/statistics", response_model=List[PlayerStats])
def get_player_statistics(
    player_id: Optional[str] = Query(None, description="Filter by player ID"),
    current_user: dict = Depends(get_current_user)
):
    """Get player statistics"""
    return PlayerService.get_player_statistics(player_id)


@router.get("/{player_id}/history", response_model=List[PlayerHistoryEntry])
def get_player_history(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a player's per-tournament participation history"""
    return PlayerService.get_player_history(player_id)


@router.get("/{player_id}/tickets", response_model=List[TicketResponse])
def get_player_tickets(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Tickets do jogador, de TODAS as etapas.

    Fica aqui (e não só em /satellite-tickets?player_id=) porque a tela do
    perfil manda o X-Stage-ID em toda requisição: se o recorte de etapa valesse,
    a vaga ganhada na etapa passada sumiria justo de onde o operador vai
    procurar por ela."""
    return SatelliteTicketService.get_all_tickets(player_id=player_id)


@router.get("/{player_id}", response_model=Player)
def get_player(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Get a specific player by ID"""
    player = PlayerService.get_player(player_id)
    if not player:
        raise nao_encontrado("jogador_nao_encontrado", "Jogador não encontrado")
    return player


@router.post("/{player_id}/consent/resend")
def resend_contact_consent(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Reenvia ao jogador o e-mail pedindo autorização para contatos.

    A leitura por `get_player` (com o JWT do usuário, sob RLS) é a guarda de
    organização: o serviço lê com service_role, e sem ela um id de outro clube
    dispararia e-mail em nome deste."""
    if not PlayerService.get_player(player_id):
        raise nao_encontrado("jogador_nao_encontrado", "Jogador não encontrado")
    try:
        return PlayerConsentService.reenviar(player_id)
    except ValueError as e:
        raise da_excecao(e)


@router.patch("/{player_id}", response_model=Player)
def update_player(
    player_id: str,
    player_data: PlayerUpdate,
    current_user: dict = Depends(get_current_user)
):
    """Update a player"""
    player = PlayerService.update_player(player_id, player_data)
    if not player:
        raise nao_encontrado("jogador_nao_encontrado", "Jogador não encontrado")
    return player


@router.delete("/{player_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_player(
    player_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Delete a player"""
    success = PlayerService.delete_player(player_id)
    if not success:
        raise nao_encontrado("jogador_nao_encontrado", "Jogador não encontrado")
