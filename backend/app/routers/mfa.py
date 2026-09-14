"""Verificação em duas etapas — a parte que é nossa.

O ENROLL, O CHALLENGE E O VERIFY NÃO PASSAM POR AQUI: são chamadas diretas do
navegador ao Supabase (`supabase.auth.mfa.*`). O segredo TOTP nunca atravessa
este backend, que é como deve ser — ele não tem por que conhecer o segredo.

O que mora aqui é o que o Supabase não oferece: os CÓDIGOS DE RECUPERAÇÃO.
Ver `app/services/mfa_service.py` para por que um código de recuperação remove
o fator em vez de promover a sessão.

A REGRA EM SI não está neste arquivo nem em nenhuma rota: ela está numa política
RESTRICTIVE em todas as 66 tabelas (database_migration_mfa_2fa.sql). Como as
consultas rodam COMO O USUÁRIO, o banco recusa quem tem 2FA e não passou pelo
segundo fator — inclusive nas rotas que ninguém lembrou de proteger. Uma trava
por rota dependeria de alguém não esquecer nenhuma das centenas que existem.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.auth.jwt import get_current_user
from app.services.mfa_service import MfaService

router = APIRouter(prefix="/auth/mfa", tags=["mfa"])


class StatusMfa(BaseModel):
    enabled: bool
    factors: List[dict] = []
    recovery_codes_remaining: int = 0


class CodigosGerados(BaseModel):
    """Os códigos em texto puro. Esta é a ÚNICA vez que eles existem: o banco
    guarda só o hash, e uma segunda chamada gera uma lista nova."""
    codes: List[str]


class UsarCodigo(BaseModel):
    code: str = Field(..., min_length=4, max_length=32)


class ResultadoDaRecuperacao(BaseModel):
    removed_factors: int
    recovery_codes_remaining: int


@router.get("/status", response_model=StatusMfa)
def status_do_2fa(user=Depends(get_current_user)):
    """A tela usa isto para decidir entre oferecer a ativação e oferecer a
    remoção, e para avisar quando os códigos estão acabando."""
    return StatusMfa(**MfaService.status(user.get("sub")))


@router.post("/recovery-codes", response_model=CodigosGerados)
def gerar_codigos(user=Depends(get_current_user)):
    """Gera (e substitui) os códigos de recuperação.

    Exige `aal2` — a trava está no serviço. Sem ela, quem tivesse só a senha
    geraria um código e o usaria para desligar o segundo fator, e o 2FA não
    protegeria nada.
    """
    codigos = MfaService.gerar_codigos(user.get("sub"), user.get("aal"))
    return CodigosGerados(codes=codigos)


@router.post("/recover", response_model=ResultadoDaRecuperacao)
def recuperar(dados: UsarCodigo, request: Request, user=Depends(get_current_user)):
    """Consome um código e remove a verificação em duas etapas da conta.

    Chamada por quem está logado com a SENHA e não tem mais o aparelho — então
    ela não pode exigir `aal2`: seria exigir exatamente o que a pessoa perdeu.
    O que a protege é o código, que só ela tem, e que vale uma vez só.
    """
    ip = request.client.host if request.client else None
    return ResultadoDaRecuperacao(
        **MfaService.recuperar(user.get("sub"), dados.code, ip)
    )
