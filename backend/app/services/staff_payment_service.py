"""Pagamento de funcionário pela etapa (Funcionários > Pagamentos).

O dinheiro sai do CAIXA GERAL. A tela fazia isso do navegador: lia o saldo,
gravava `saldo − valor` por cima e marcava o pagamento numa segunda escrita.
Dois pagamentos juntos (duas abas, dois operadores) liam o mesmo saldo e um
deles sumia do caixa; e um erro entre as duas escritas deixava o funcionário
pago sem o dinheiro ter saído, ou o contrário.

Aqui segue o desenho do pagamento de prêmio:
1. RESERVA: a mudança de status é condicional (pending → paid), então só um
   pagamento passa — o clique duplo não paga duas vezes;
2. o caixa geral move pela RPC atômica (débito só com saldo);
3. se o passo 2 falha, a reserva é desfeita.
O estorno faz o caminho inverso (paid → pending, depois o crédito).
"""
from datetime import datetime, timezone
from typing import Optional

from app.database import supabase
from app.utils.erros import ErroDeNegocio


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _caixa_geral():
    from app.services.cash_register_service import CashRegisterService
    return CashRegisterService.get_general_cash()


def _pagamento(stage_id: str, staff_id: str) -> Optional[dict]:
    linhas = (
        supabase.table("staff_payments").select("*")
        .eq("stage_id", stage_id).eq("staff_id", staff_id).limit(1).execute().data or []
    )
    return linhas[0] if linhas else None


class StaffPaymentService:
    @staticmethod
    def pay(stage_id: str, staff_id: str, amount: float, user_id: Optional[str]) -> dict:
        valor = round(float(amount or 0), 2)
        if valor <= 0:
            raise ErroDeNegocio(
                "valor_do_pagamento_obrigatorio", "Defina um valor antes de pagar."
            )
        geral = _caixa_geral()
        if float(geral.current_balance) < valor:
            raise ErroDeNegocio(
                "saldo_insuficiente_no_caixa_geral",
                f"Saldo insuficiente no caixa geral. Disponível: {float(geral.current_balance):.2f}",
                disponivel=float(geral.current_balance),
                solicitado=valor,
            )

        agora = _agora()
        pago = {"amount": valor, "status": "paid", "paid_at": agora,
                "paid_by": user_id, "updated_at": agora}

        # ── 1. Reserva ──
        anterior = _pagamento(stage_id, staff_id)
        if anterior:
            reservado = (
                supabase.table("staff_payments").update(pago)
                .eq("id", anterior["id"]).neq("status", "paid").execute().data or []
            )
        else:
            try:
                reservado = (
                    supabase.table("staff_payments")
                    .insert({"stage_id": stage_id, "staff_id": staff_id, **pago})
                    .execute().data or []
                )
            except Exception:
                # UNIQUE (stage_id, staff_id): outra tela criou o pagamento agora.
                reservado = []
        if not reservado:
            raise ErroDeNegocio(
                "pagamento_de_funcionario_ja_registrado",
                "Este pagamento já foi registrado.",
                status=409,
            )
        linha = reservado[0]

        # ── 2. Caixa geral: débito atômico ──
        try:
            saldo = supabase.rpc(
                "debit_general_cash_register",
                {"p_register_id": str(geral.id), "p_amount": valor},
            ).execute().data
            if saldo is None or saldo == []:
                raise ErroDeNegocio(
                    "saldo_insuficiente_no_caixa_geral",
                    "Saldo insuficiente no caixa geral.",
                    disponivel=float(geral.current_balance),
                    solicitado=valor,
                )
        except Exception:
            # ── 3. Desfaz a reserva ──
            if anterior:
                supabase.table("staff_payments").update({
                    "amount": anterior.get("amount"),
                    "status": anterior.get("status") or "pending",
                    "paid_at": anterior.get("paid_at"),
                    "paid_by": anterior.get("paid_by"),
                    "updated_at": _agora(),
                }).eq("id", linha["id"]).execute()
            else:
                supabase.table("staff_payments").delete().eq("id", linha["id"]).execute()
            raise
        return linha

    @staticmethod
    def reverse(payment_id: str, user_id: Optional[str]) -> dict:
        linhas = (
            supabase.table("staff_payments").select("*")
            .eq("id", payment_id).limit(1).execute().data or []
        )
        if not linhas:
            raise ErroDeNegocio(
                "pagamento_de_funcionario_nao_encontrado",
                "Pagamento não encontrado.",
                status=404,
            )
        pagamento = linhas[0]
        valor = round(float(pagamento.get("amount") or 0), 2)

        # ── 1. Reserva do estorno: só um passa ──
        revertido = (
            supabase.table("staff_payments")
            .update({"status": "pending", "paid_at": None, "paid_by": None, "updated_at": _agora()})
            .eq("id", payment_id).eq("status", "paid").execute().data or []
        )
        if not revertido:
            raise ErroDeNegocio(
                "pagamento_de_funcionario_nao_pago",
                "Este pagamento não está pago.",
                status=409,
            )

        # ── 2. Caixa geral: crédito atômico ──
        if valor > 0:
            try:
                supabase.rpc(
                    "credit_general_cash_register",
                    {"p_register_id": str(_caixa_geral().id), "p_amount": valor},
                ).execute()
            except Exception:
                supabase.table("staff_payments").update({
                    "status": "paid",
                    "paid_at": pagamento.get("paid_at"),
                    "paid_by": pagamento.get("paid_by"),
                    "updated_at": _agora(),
                }).eq("id", payment_id).execute()
                raise
        return revertido[0]
