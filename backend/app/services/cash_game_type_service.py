"""Catálogo de modalidades de cash game (os "stakes").

É o equivalente dos `buy_types` do torneio: o que a mesa cobra e como. Fica na
ORGANIZAÇÃO, não no dia — a mesa de R$1/2 é a mesma todo dia, e recadastrá-la a
cada noite seria trabalho puro e fonte de divergência entre dias.

O que a mesa faz com isso é COPIAR os valores na abertura (ver
CashTableService.open_table). Mudar o rake aqui amanhã não pode reescrever a
apuração da mesa de ontem.
"""
from typing import List, Optional

from app.database import supabase
from app.models.cash_game import (
    CashGameTypeCreate,
    CashGameTypeResponse,
    CashGameTypeUpdate,
)
from app.utils.erros import ErroDeNegocio


class CashGameTypeService:

    @staticmethod
    def list_types(
        organization_id: Optional[str] = None,
        active: Optional[bool] = None,
    ) -> List[CashGameTypeResponse]:
        query = supabase.table("cash_game_types").select("*")
        if organization_id:
            query = query.eq("organization_id", organization_id)
        if active is not None:
            query = query.eq("active", active)
        resp = query.order("sort_order").execute()
        return [CashGameTypeResponse(**r) for r in (resp.data or [])]

    @staticmethod
    def get_type(type_id: str) -> dict:
        resp = supabase.table("cash_game_types").select("*").eq("id", type_id).execute()
        if not resp.data:
            raise ErroDeNegocio(
                "modalidade_nao_encontrada", "Modalidade não encontrada.", status=404
            )
        return resp.data[0]

    @staticmethod
    def create(
        data: CashGameTypeCreate, organization_id: Optional[str] = None
    ) -> CashGameTypeResponse:
        CashGameTypeService._validar(data.small_blind, data.big_blind,
                                    data.min_buy_in, data.max_buy_in)
        payload = data.model_dump()
        if organization_id:
            payload["organization_id"] = organization_id
        resp = supabase.table("cash_game_types").insert(payload).execute()
        return CashGameTypeResponse(**resp.data[0])

    @staticmethod
    def update(type_id: str, data: CashGameTypeUpdate) -> CashGameTypeResponse:
        atual = CashGameTypeService.get_type(type_id)
        mudancas = data.model_dump(exclude_unset=True)
        if not mudancas:
            return CashGameTypeResponse(**atual)

        # Valida a linha COMO ELA FICARÁ, não só o que veio no corpo: um PATCH
        # que baixa só o big blind poderia deixá-lo abaixo do small.
        futuro = {**atual, **mudancas}
        CashGameTypeService._validar(
            float(futuro["small_blind"]), float(futuro["big_blind"]),
            float(futuro["min_buy_in"]),
            float(futuro["max_buy_in"]) if futuro.get("max_buy_in") is not None else None,
        )
        resp = supabase.table("cash_game_types").update(mudancas).eq("id", type_id).execute()
        return CashGameTypeResponse(**resp.data[0])

    @staticmethod
    def delete(type_id: str) -> dict:
        """Modalidade usada por alguma mesa é DESATIVADA, não apagada.

        A mesa guarda um retrato dos valores, então apagar não corromperia
        número nenhum — mas o histórico perderia o nome ("NLH 1/2" viraria
        vazio no relatório), e o nome é como o clube fala da mesa.
        """
        CashGameTypeService.get_type(type_id)
        usos = supabase.table("cash_tables").select("id") \
            .eq("game_type_id", type_id).limit(1).execute()
        if usos.data:
            supabase.table("cash_game_types").update({"active": False}) \
                .eq("id", type_id).execute()
            return {"message": "Modalidade desativada", "deactivated": True}

        supabase.table("cash_game_types").delete().eq("id", type_id).execute()
        return {"message": "Modalidade removida", "deactivated": False}

    @staticmethod
    def _validar(small: float, big: float, minimo: float, maximo: Optional[float]) -> None:
        if big < small:
            raise ErroDeNegocio(
                "blinds_invalidos",
                "O big blind não pode ser menor que o small blind.",
                small_blind=small, big_blind=big,
            )
        if maximo is not None and maximo < minimo:
            raise ErroDeNegocio(
                "buy_in_maximo_menor_que_minimo",
                "O buy-in máximo não pode ser menor que o mínimo.",
                minimo=minimo, maximo=maximo,
            )
