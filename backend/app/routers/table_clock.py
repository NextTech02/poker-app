"""Relógio de mesa e time bank. As regras moram em TableClockService."""
from typing import List

from fastapi import APIRouter, Depends

from app.auth.permissions import require_permission
from app.models.table_clock import CartaoUsado, ConfiguracaoDoRelogio, PedidoDeAjuste
from app.services.table_clock_service import TableClockService
from app.utils.erros import ErroDeNegocio

router = APIRouter(prefix="/table-clock", tags=["table-clock"])

# `table_clock` é a chave do dealer: abre o tablet e nada além dele. As outras
# entram junto para quem já administra o clube não depender de backfill, como em
# MASTER_PERMS (satellite_tickets.py). Mesma lista de PERMISSOES_DO_RELOGIO no
# frontend (components/menus.js).
OPERAR = ("table_clock", "tables", "tournaments", "employees")
# Mudar a regra do dia e mexer em saldo é do floor, nunca do dealer.
GERIR = ("tables", "tournaments", "employees")


@router.get("/days")
def listar_dias_abertos(user=Depends(require_permission(*OPERAR))) -> List[dict]:
    return TableClockService.dias_abertos()


@router.get("/day/{day_id}/settings", response_model=ConfiguracaoDoRelogio)
def obter_configuracao(day_id: str, user=Depends(require_permission(*OPERAR))):
    return TableClockService.obter_configuracao(day_id)


@router.put("/day/{day_id}/settings", response_model=ConfiguracaoDoRelogio)
def salvar_configuracao(
    day_id: str, data: ConfiguracaoDoRelogio, user=Depends(require_permission(*GERIR)),
):
    try:
        return TableClockService.salvar_configuracao(day_id, data)
    except ErroDeNegocio as erro:
        raise erro.como_http()


@router.get("/day/{day_id}/panel")
def painel_do_dia(day_id: str, user=Depends(require_permission(*GERIR))):
    try:
        return TableClockService.painel_do_dia(day_id)
    except ErroDeNegocio as erro:
        raise erro.como_http()


@router.get("/day/{day_id}/events")
def historico_do_dia(day_id: str, user=Depends(require_permission(*GERIR))) -> List[dict]:
    return TableClockService.historico(day_id)


@router.post("/day/{day_id}/players/{tournament_player_id}/adjust")
def ajustar_cartoes(
    day_id: str,
    tournament_player_id: str,
    data: PedidoDeAjuste,
    user=Depends(require_permission(*GERIR)),
):
    try:
        return TableClockService.ajustar(day_id, tournament_player_id, data, user.get("sub"))
    except ErroDeNegocio as erro:
        raise erro.como_http()


@router.get("/table/{table_id}")
def estado_da_mesa(table_id: str, user=Depends(require_permission(*OPERAR))):
    try:
        return TableClockService.estado_da_mesa(table_id)
    except ErroDeNegocio as erro:
        raise erro.como_http()


@router.post("/table/{table_id}/cards")
def usar_cartao(table_id: str, data: CartaoUsado, user=Depends(require_permission(*OPERAR))):
    try:
        return TableClockService.usar_cartao(table_id, data, user.get("sub"))
    except ErroDeNegocio as erro:
        raise erro.como_http()


@router.post("/events/{event_id}/undo")
def desfazer_uso(event_id: str, user=Depends(require_permission(*OPERAR))):
    try:
        return TableClockService.desfazer_uso(event_id, user.get("sub"))
    except ErroDeNegocio as erro:
        raise erro.como_http()
