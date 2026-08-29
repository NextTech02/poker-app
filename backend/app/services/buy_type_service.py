"""Meios de entrada de um dia do torneio (`buy_types` com `tournament_day_id`).

Antes o tipo pertencia à ETAPA e só dizia o rake; valor e fichas vinham do dia.
Agora ele pertence ao DIA e carrega valor, rake e fichas — é o que faz o "rebuy
duplo" ser uma venda própria em vez do rebuy simples multiplicado.
"""
import logging
from typing import List, Optional

from app.database import supabase

logger = logging.getLogger("uvicorn.error")

# Colunas gravadas/lidas. Explícitas para que uma coluna nova no banco não entre
# no payload sem alguém decidir o que ela significa na venda.
_COLUNAS = "id, tournament_day_id, name, category, amount, rake_percentage, chips, active, sort_order"


class BuyTypeService:
    @staticmethod
    def listar(day_id: str) -> List[dict]:
        """Meios de entrada do dia, na ordem em que o Caixa deve mostrá-los."""
        resposta = (
            supabase.table("buy_types")
            .select(_COLUNAS)
            .eq("tournament_day_id", day_id)
            .order("sort_order")
            .execute()
        )
        return resposta.data or []

    @staticmethod
    def _com_venda(ids: List[str]) -> set:
        """Quais desses meios de entrada já foram vendidos alguma vez.

        UMA consulta para todos, e não uma por linha: configurar um dia com
        vários meios não pode virar uma rajada de idas ao banco (cada uma custa
        ~270ms nesta instalação).

        Falhar aqui responde "todos têm venda" de propósito: sem saber, o
        caminho seguro é NÃO apagar. Uma linha desativada a mais o operador
        resolve; um recibo que perdeu o rótulo do que foi vendido, não.
        """
        try:
            linhas = (
                supabase.table("transactions")
                .select("buy_type_id")
                .in_("buy_type_id", ids)
                .execute()
                .data
                or []
            )
        except Exception:
            logger.warning(
                "não consegui conferir vendas dos meios de entrada %s; tratando "
                "todos como vendidos para não apagar histórico", ids, exc_info=True,
            )
            return set(ids)
        return {l["buy_type_id"] for l in linhas if l.get("buy_type_id")}

    @staticmethod
    def _organizacao_do_dia(day_id: str) -> Optional[str]:
        """Organização dona do dia — as linhas novas nascem com ela.

        Sem isso a linha ficaria órfã do multi-tenant: o backend usa a chave de
        serviço e o RLS não a preencheria sozinho, então o dia veria meios de
        entrada que não aparecem para mais ninguém.
        """
        try:
            linhas = (
                supabase.table("tournament_days")
                .select("organization_id")
                .eq("id", day_id)
                .execute()
                .data
                or []
            )
        except Exception:
            logger.warning("dia %s sem organization_id legível", day_id, exc_info=True)
            return None
        return linhas[0].get("organization_id") if linhas else None

    @staticmethod
    def substituir(day_id: str, itens: List[dict]) -> List[dict]:
        """Troca a lista inteira do dia e devolve como ela ficou.

        REGRA DO QUE SOME: o que não veio na lista é apagado só quando NUNCA foi
        vendido. Com venda, ele é apenas desativado — `transactions.buy_type_id`
        é ON DELETE SET NULL, então apagar faria o recibo perder a referência do
        que a pessoa comprou (e o relatório de rake por meio de entrada, o
        agrupamento).
        """
        if not any(i.get("active", True) and i.get("category") == "buy_in" for i in itens):
            # Sem meio de entrada ativo de buy-in não há como inscrever ninguém:
            # o Caixa abriria sem nenhuma opção de venda e o dia ficaria parado.
            raise ValueError(
                "É preciso ao menos um meio de entrada ativo na categoria buy-in"
            )

        atuais = {l["id"]: l for l in BuyTypeService.listar(day_id)}

        enviados_com_id = [i["id"] for i in itens if i.get("id")]
        intrusos = [i for i in enviados_com_id if i not in atuais]
        if intrusos:
            # Aceitar um id de outro dia faria o upsert ROUBAR aquela linha para
            # cá, e o outro dia perderia o meio de entrada dele no meio do evento.
            raise ValueError(
                f"Meio de entrada não pertence a este dia: {', '.join(intrusos)}"
            )

        org_id = BuyTypeService._organizacao_do_dia(day_id)

        def _payload(item: dict) -> dict:
            return {
                "tournament_day_id": day_id,
                "name": item["name"].strip(),
                "category": item["category"],
                "amount": item["amount"],
                "rake_percentage": item.get("rake_percentage", 0),
                "chips": item.get("chips", 0),
                "active": item.get("active", True),
                "sort_order": item.get("sort_order", 0),
                "organization_id": org_id,
            }

        # Uma escrita por operação (não uma por linha): editar seis meios de
        # entrada não pode custar seis idas ao banco.
        novos = [_payload(i) for i in itens if not i.get("id")]
        if novos:
            supabase.table("buy_types").insert(novos).execute()

        editados = [{**_payload(i), "id": i["id"]} for i in itens if i.get("id")]
        if editados:
            supabase.table("buy_types").upsert(editados).execute()

        ficaram = set(enviados_com_id)
        removidos = [i for i in atuais if i not in ficaram]
        if removidos:
            vendidos = BuyTypeService._com_venda(removidos)
            apagaveis = [i for i in removidos if i not in vendidos]
            if apagaveis:
                supabase.table("buy_types").delete().in_("id", apagaveis).execute()
            # Os vendidos saem do Caixa por DESATIVAÇÃO: continuam existindo para
            # o histórico que aponta para eles. Num `in_` só, não um update por
            # linha.
            desativar = [i for i in removidos if i in vendidos]
            if desativar:
                supabase.table("buy_types").update({"active": False}).in_(
                    "id", desativar
                ).execute()

        return BuyTypeService.listar(day_id)
