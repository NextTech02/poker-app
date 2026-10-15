"""Meios de entrada de um TORNEIO (`buy_types` com `tournament_id`).

Histórico: o tipo nasceu na ETAPA e só dizia o rake; depois passou ao DIA e
ganhou valor e fichas — é o que faz o "rebuy duplo" ser uma venda própria em vez
do rebuy simples multiplicado. Agora é do TORNEIO: os dias do mesmo torneio
vendem a mesma coisa, e configurar dia a dia repetia a lista N vezes. Um flight
com valor diferente vira um meio a mais na mesma lista, não uma lista à parte.
"""
import logging
from typing import List, Optional

from app.database import supabase

logger = logging.getLogger("uvicorn.error")

# Colunas gravadas/lidas. Explícitas para que uma coluna nova no banco não entre
# no payload sem alguém decidir o que ela significa na venda.
_COLUNAS = "id, tournament_id, name, category, amount, rake_percentage, chips, active, sort_order"
# `per_team` (torneio por equipes) só existe depois da migração de equipes.
_COLUNAS_COM_EQUIPE = _COLUNAS + ", per_team"

# Colunas antigas do DIA que seguem o primeiro meio ativo de cada categoria.
# Elas continuam sendo lidas como RESERVA (venda sem tipo, bilhete de satélite,
# réplica offline) e aparecem no detalhe do torneio: se não acompanharem a
# lista, contam uma história diferente da que o Caixa cobra.
_COLUNAS_DO_DIA = {
    "buy_in": ("buy_in", "starting_chips"),
    "rebuy": ("rebuy_amount", "rebuy_chips"),
    "addon": ("addon_amount", "addon_chips"),
}


class BuyTypeService:
    @staticmethod
    def listar(tournament_id: str) -> List[dict]:
        """Meios de entrada do torneio, na ordem em que o Caixa deve mostrá-los."""
        for colunas in (_COLUNAS_COM_EQUIPE, _COLUNAS):
            try:
                resposta = (
                    supabase.table("buy_types")
                    .select(colunas)
                    .eq("tournament_id", tournament_id)
                    .order("sort_order")
                    .execute()
                )
                return resposta.data or []
            except Exception:
                if colunas == _COLUNAS:
                    raise
        return []

    @staticmethod
    def _com_venda(ids: List[str]) -> set:
        """Quais desses meios de entrada já foram vendidos alguma vez.

        UMA consulta para todos, e não uma por linha: configurar um torneio com
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
    def _organizacao_do_torneio(tournament_id: str) -> Optional[str]:
        """Organização dona do torneio — as linhas novas nascem com ela.

        Sem isso a linha ficaria órfã do multi-tenant: o backend usa a chave de
        serviço e o RLS não a preencheria sozinho, então o torneio veria meios
        de entrada que não aparecem para mais ninguém.
        """
        try:
            linhas = (
                supabase.table("tournaments")
                .select("organization_id")
                .eq("id", tournament_id)
                .execute()
                .data
                or []
            )
        except Exception:
            logger.warning("torneio %s sem organization_id legível", tournament_id, exc_info=True)
            return None
        return linhas[0].get("organization_id") if linhas else None

    @staticmethod
    def colunas_do_dia(itens: List[dict]) -> dict:
        """As colunas antigas do dia, a partir do primeiro meio ATIVO de cada categoria.

        Rebuy/add-on zerados viram NULO, não zero: "rebuy de R$ 0,00" diria que
        o rebuy é de graça; nulo diz que ele não existe — e é o que o CHECK
        (`> 0`) da coluna aceita. O buy-in fica numérico (o CHECK dele é `>= 0`).
        """
        # O meio "por equipe" tem o preço da EQUIPE: não é o buy-in de um jogador.
        ativos = sorted(
            (i for i in itens if i.get("active", True) and not i.get("per_team")),
            key=lambda i: i.get("sort_order", 0),
        )
        colunas = {}
        for categoria, (col_valor, col_fichas) in _COLUNAS_DO_DIA.items():
            primeiro = next((i for i in ativos if i.get("category") == categoria), None)
            valor = float(primeiro.get("amount") or 0) if primeiro else 0.0
            if categoria == "buy_in":
                colunas[col_valor] = valor
            else:
                colunas[col_valor] = valor if valor > 0 else None
            colunas[col_fichas] = int(primeiro.get("chips") or 0) if primeiro else 0
        return colunas

    @staticmethod
    def _espelhar_nos_dias(tournament_id: str, itens: List[dict]) -> None:
        """Leva a lista para as colunas antigas dos dias que vendem entrada.

        O dia final fica de fora: quem chega lá vem classificado, e as colunas
        dele ficam zeradas de propósito. Best-effort — a lista já foi gravada, e
        uma coluna de exibição desatualizada não pode derrubar a configuração.
        """
        try:
            (
                supabase.table("tournament_days")
                .update(BuyTypeService.colunas_do_dia(itens))
                .eq("tournament_id", tournament_id)
                .neq("day_type", "final")
                .execute()
            )
        except Exception:
            logger.warning(
                "não consegui espelhar os meios de entrada nas colunas dos dias do torneio %s",
                tournament_id, exc_info=True,
            )

    @staticmethod
    def substituir(tournament_id: str, itens: List[dict]) -> List[dict]:
        """Troca a lista inteira do torneio e devolve como ela ficou.

        REGRA DO QUE SOME: o que não veio na lista é apagado só quando NUNCA foi
        vendido. Com venda, ele é apenas desativado — `transactions.buy_type_id`
        é ON DELETE SET NULL, então apagar faria o recibo perder a referência do
        que a pessoa comprou (e o relatório de rake por meio de entrada, o
        agrupamento).
        """
        if not any(i.get("active", True) and i.get("category") == "buy_in" for i in itens):
            # Sem meio de entrada ativo de buy-in não há como inscrever ninguém:
            # o Caixa abriria sem nenhuma opção de venda e o torneio ficaria parado.
            raise ValueError(
                "É preciso ao menos um meio de entrada ativo na categoria buy-in"
            )

        atuais = {l["id"]: l for l in BuyTypeService.listar(tournament_id)}

        enviados_com_id = [i["id"] for i in itens if i.get("id")]
        intrusos = [i for i in enviados_com_id if i not in atuais]
        if intrusos:
            # Aceitar um id de outro torneio faria o upsert ROUBAR aquela linha
            # para cá, e o outro torneio perderia o meio de entrada dele no meio
            # do evento.
            raise ValueError(
                f"Meio de entrada não pertence a este torneio: {', '.join(intrusos)}"
            )

        org_id = BuyTypeService._organizacao_do_torneio(tournament_id)
        # Banco sem a migração de equipes: não manda a coluna nova (a não ser
        # que alguém tenha marcado "por equipe" — aí o erro é o certo). Vai em
        # TODAS as linhas ou em nenhuma: no insert em lote o PostgREST usa a
        # união das chaves e grava NULL onde a linha não trouxe a coluna.
        com_coluna_de_equipe = (
            any("per_team" in l for l in atuais.values())
            or any(i.get("per_team") for i in itens)
        )

        def _payload(item: dict) -> dict:
            extra = {}
            if com_coluna_de_equipe:
                extra["per_team"] = bool(item.get("per_team"))
            return {
                **extra,
                "tournament_id": tournament_id,
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

        BuyTypeService._espelhar_nos_dias(tournament_id, itens)

        return BuyTypeService.listar(tournament_id)
