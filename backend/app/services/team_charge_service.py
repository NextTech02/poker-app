"""Torneio por equipes: cobrar a inscrição da EQUIPE num lançamento só.

O clube ainda não decidiu se a inscrição é por equipe ou por jogador — os dois
jeitos funcionam:
- por jogador: cada integrante compra no Caixa de sempre;
- por equipe: um meio de entrada marcado "por equipe" (`buy_types.per_team`,
  `amount` = preço da EQUIPE) é dividido entre os integrantes. Cada um ganha a
  SUA inscrição e a SUA venda, então relatórios, estorno, contadores e o pozo
  continuam funcionando por jogador.
"""
import uuid
from decimal import ROUND_DOWN, Decimal
from typing import List, Optional

from app.database import supabase
from app.services.team_service import TeamService, _org
from app.utils.erros import ErroDeNegocio

_CENTAVO = Decimal("0.01")


def repartir(total: Decimal, partes: int) -> List[Decimal]:
    """Divide ao centavo; os centavos que sobram vão para as PRIMEIRAS partes
    (o capitão vem primeiro)."""
    if partes <= 0:
        return []
    base = (total / partes).quantize(_CENTAVO, rounding=ROUND_DOWN)
    sobra = int(((total - base * partes) / _CENTAVO).to_integral_value())
    return [base + (_CENTAVO if i < sobra else Decimal("0")) for i in range(partes)]


class TeamChargeService:
    @staticmethod
    def cobrar(tournament_id: str, team_id: str, buy_type_id: str, payment_method: str = "cash",
               client_mutation_id: Optional[str] = None, user_id: Optional[str] = None) -> dict:
        """Conferências UMA vez e dois inserts em lote: chamar `register_player`
        quatro vezes custaria ~40 idas ao banco (~11 s com o banco em outra
        região). Quem já se inscreveu sozinho no Caixa não é cobrado de novo."""
        from app.services.cashbox_service import CashboxService
        from app.services.sales_block_service import SalesBlockService
        from app.services.tournament_day_service import _chipcount_cache
        from app.services.tournament_player_service import TournamentPlayerService

        torneio = TeamService.torneio(tournament_id)
        equipe = TeamService._equipe(tournament_id, team_id)
        fase1, _ = TeamService.dias(tournament_id)
        if not fase1:
            raise ErroDeNegocio("torneio_sem_dia_da_fase1", "Crie o dia da Fase 1 antes de cobrar as equipes.")
        capitao = str(equipe.get("captain_player_id"))
        membros = sorted(
            supabase.table("tournament_team_members").select("*").eq("team_id", str(team_id)).execute().data or [],
            key=lambda m: (str(m["player_id"]) != capitao, m.get("relay_order") or 0),
        )
        if not membros:
            raise ErroDeNegocio("equipe_sem_integrantes", "Esta equipe não tem integrantes.")

        # Reenvio do mesmo clique (a rede caiu na resposta): não cobra duas vezes.
        if client_mutation_id:
            chaves = [f"{client_mutation_id}:{i}" for i in range(len(membros))]
            if supabase.table("transactions").select("id").in_("client_id", chaves).execute().data:
                return {**TeamService.listar(tournament_id), "charged": 0, "amount": 0}

        CashboxService.require_open_cashbox_for_tournament(user_id, str(tournament_id))
        SalesBlockService.assert_sales_allowed(str(tournament_id), str(fase1["id"]), day_row=fase1)

        tipos = supabase.table("buy_types").select("*").eq("id", str(buy_type_id)).execute().data or []
        tipo = tipos[0] if tipos else None
        if (not tipo or not tipo.get("per_team") or (tipo.get("category") or "buy_in") != "buy_in"
                or str(tipo.get("tournament_id")) != str(tournament_id)):
            raise ErroDeNegocio(
                "meio_de_entrada_nao_e_por_equipe", "Escolha um meio de entrada cobrado por equipe.",
            )
        if tipo.get("active") is False:
            raise ErroDeNegocio("meio_de_entrada_inativo", "Este meio de entrada foi desativado. Escolha outro.")

        ids = [str(m["player_id"]) for m in membros]
        ja = {
            str(t["player_id"]) for t in (
                supabase.table("tournament_players").select("player_id, status")
                .eq("tournament_day_id", str(fase1["id"])).in_("player_id", ids).execute().data or []
            ) if t.get("status") != "cancelled"
        }
        a_cobrar = [m for m in membros if str(m["player_id"]) not in ja]
        if not a_cobrar:
            raise ErroDeNegocio(
                "equipe_ja_inscrita", "Todos os integrantes desta equipe já estão inscritos.", status=409,
            )
        maximo = int(fase1.get("max_players") or 0)
        inscritos = int(fase1.get("registered_players") or 0)
        if maximo and inscritos + len(a_cobrar) > maximo:
            raise ErroDeNegocio(
                "dia_lotado", f"Não há vagas para a equipe inteira ({inscritos}/{maximo}).",
                status=409, inscritos=inscritos, maximo=maximo,
            )

        partes = repartir(Decimal(str(tipo.get("amount") or 0)).quantize(_CENTAVO), len(membros))
        parte_de = {str(m["player_id"]): partes[i] for i, m in enumerate(membros)}
        fichas = TournamentPlayerService._fichas_do_tipo(tipo, fase1.get("starting_chips"))
        rake_pct = float(tipo.get("rake_percentage") or 0)

        inscricoes = [{
            "id": str(uuid.uuid4()),
            **_org(torneio),
            "tournament_id": str(tournament_id),
            "tournament_day_id": str(fase1["id"]),
            "player_id": str(m["player_id"]),
            "buy_in_count": 1,
            "total_buy_in_amount": float(parte_de[str(m["player_id"])]),
            "total_chips": fichas,
            "notes": f"Equipe {equipe.get('name')}",
        } for m in a_cobrar]
        supabase.table("tournament_players").insert(inscricoes).execute()

        vendas = []
        for i, (m, inscricao) in enumerate(zip(a_cobrar, inscricoes)):
            valor = parte_de[str(m["player_id"])]
            venda = {
                **_org(torneio),
                "tournament_id": str(tournament_id),
                "player_id": str(m["player_id"]),
                "tournament_player_id": inscricao["id"],
                "type": "buy_in",
                "amount": float(valor),
                "payment_source": "cash",
                "payment_method": payment_method or "cash",
                "buy_type_id": str(buy_type_id),
                "buy_type_name": tipo.get("name"),
                "rake_percentage": rake_pct,
                "rake_amount": round(float(valor) * rake_pct / 100, 2),
                "bounty_amount": 0,
                "chips": fichas,
                "created_by": user_id,
            }
            if client_mutation_id:
                venda["client_id"] = f"{client_mutation_id}:{i}"
            vendas.append(venda)
        try:
            supabase.table("transactions").insert(vendas).execute()
        except Exception:
            # Sem as vendas, as inscrições não ficam: o operador tenta de novo.
            supabase.table("tournament_players").update({"status": "cancelled"}) \
                .in_("id", [i["id"] for i in inscricoes]).execute()
            raise
        _chipcount_cache.pop(str(fase1["id"]), None)
        total = sum((parte_de[str(m["player_id"])] for m in a_cobrar), Decimal("0"))
        return {**TeamService.listar(tournament_id), "charged": len(a_cobrar), "amount": float(total)}

    @staticmethod
    def estornar(tournament_id: str, team_id: str, reason: Optional[str] = None,
                 user_id: Optional[str] = None) -> dict:
        """Estorna as vendas "por equipe" dos integrantes, cada uma pelo estorno
        de sempre (devolve caixa, contadores e fichas). Repetir é seguro.
        Estornar UM integrante pelo Caixa continua valendo (substituição)."""
        from app.services.transaction_service import TransactionService

        TeamService.torneio(tournament_id)
        TeamService._equipe(tournament_id, team_id)
        membros = (
            supabase.table("tournament_team_members").select("player_id")
            .eq("team_id", str(team_id)).execute().data or []
        )
        ids = [str(m["player_id"]) for m in membros]
        vendas = (
            supabase.table("transactions").select("id, buy_type_id, status, type")
            .eq("tournament_id", str(tournament_id)).in_("player_id", ids).eq("type", "buy_in").execute().data or []
        ) if ids else []
        tipos_ids = sorted({str(v["buy_type_id"]) for v in vendas if v.get("buy_type_id")})
        por_equipe = {
            str(t["id"]) for t in (
                supabase.table("buy_types").select("id, per_team").in_("id", tipos_ids).execute().data or []
            ) if t.get("per_team")
        } if tipos_ids else set()
        alvo = [v for v in vendas
                if str(v.get("buy_type_id")) in por_equipe and (v.get("status") or "active") != "cancelled"]
        if not alvo:
            raise ErroDeNegocio(
                "equipe_sem_cobranca", "Não há cobrança por equipe ativa para estornar.", status=409,
            )
        falhas = []
        for v in alvo:
            try:
                TransactionService.cancel_transaction(str(v["id"]), user_id, reason or "Estorno da cobrança da equipe")
            except ValueError as e:
                falhas.append(str(e))
        if falhas:
            raise ErroDeNegocio(
                "estorno_de_equipe_parcial",
                f"{len(alvo) - len(falhas)} de {len(alvo)} vendas estornadas. Motivo: {falhas[0]}",
                status=409, estornadas=len(alvo) - len(falhas), total=len(alvo),
            )
        return {**TeamService.listar(tournament_id), "cancelled": len(alvo)}
