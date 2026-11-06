"""Dados extras do telão PÚBLICO (sem login).

A TV do salão abre `/tv/<código>` sem autenticar. O relógio sempre foi
público, mas a premiação não: `GET /tournaments/{id}/prizes` exige login, então
a TV anônima nunca mostrava os prêmios (401 silencioso → lista vazia). A moeda
tinha o mesmo problema, pior: a tela lia `app_settings` sem filtro e, como
anônima, pegava a linha de uma organização QUALQUER.

Aqui tudo é lido com a chave de serviço — de propósito. Se um operador logado
abrir o telão, o request leva JWT e o proxy `supabase` rodaria como ele; um
funcionário sem permissão de premiação veria o telão sem prêmios. O telão é
o mesmo para todo mundo no salão, então a leitura não depende de quem abriu.
"""
import logging
from typing import Optional

from app.database.supabase_client import supabase_admin
from app.models.public_tv import (
    PublicSeat,
    PublicSeating,
    PublicTvBuyType,
    PublicTvExtras,
    PublicTvPrize,
)
from app.services.module_service import ModuleService
from app.services.prize_allocation_service import PrizeAllocationService
from app.services.transaction_filters import entradas_da_venda, ler_transacoes_ativas
from app.utils.cache_curto import CacheCurto
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger(__name__)

MOEDA_PADRAO = "BRL"
IDIOMA_PADRAO = "pt-BR"

# Tudo aqui é lido com a chave de serviço e é IGUAL para qualquer TV do salão
# (ver o docstring do módulo) — então várias TVs do mesmo dia podem ser
# servidas pela mesma leitura. Os extras custam 11 a 13 consultas (premiação,
# meios de entrada, KO) e cada TV pede a cada 30 s; o quadro de mesas, a cada
# 20 s. A validade é o atraso máximo a mais que o telão pode mostrar.
_extras_do_dia = CacheCurto(validade_s=15)
_quadro_de_mesas = CacheCurto(validade_s=10)
# Moeda e idioma do clube quase nunca mudam.
_ajustes_do_clube = CacheCurto(validade_s=60)

# Só o que o telão mostra. `player_name`, documento e `paid_*` ficam de fora:
# a rota é aberta à internet.
_CAMPOS_DO_PREMIO = (
    "position, prize_amount, prize_type, vaga_target_tournament_id, vaga_target_day_id, visible"
)


class PublicTvService:

    @staticmethod
    def get_day_extras(day_id: str) -> PublicTvExtras:
        """Extras do telão do dia, servidos a todas as TVs da mesma leitura por
        até 15 s (`_extras_do_dia`). O 404 de dia inexistente não é guardado."""
        return _extras_do_dia.obter(str(day_id), lambda: PublicTvService._montar_extras(day_id))

    @staticmethod
    def _montar_extras(day_id: str) -> PublicTvExtras:
        resp = (
            supabase_admin.table("tournament_days")
            .select("id, tournament_id, organization_id, day_type")
            .eq("id", day_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            # 404 seco: sem dizer se o id existe em outro clube.
            raise ErroDeNegocio("dia_nao_encontrado", "Dia não encontrado.", status=404)
        day = rows[0]
        tournament_id = str(day.get("tournament_id"))
        org_id = day.get("organization_id")

        ajustes = PublicTvService._org_settings(org_id)
        resumo = PublicTvService._resumo(tournament_id)
        return PublicTvExtras(
            day_id=str(day["id"]),
            tournament_id=tournament_id,
            organization_name=ModuleService.org_name(org_id),
            currency=ajustes["currency"],
            language=ajustes["language"],
            prize_pool=PublicTvService._prize_pool(resumo),
            guaranteed_prize=PublicTvService._garantido(resumo),
            prizes=PublicTvService._prizes(tournament_id),
            buy_types=PublicTvService._buy_types(tournament_id, str(day["id"])),
            # Só o dia FINAL pode ter revezamento: nos outros, nenhuma consulta a mais.
            relay=PublicTvService._revezamento(tournament_id) if day.get("day_type") == "final" else None,
            **PublicTvService._ko(tournament_id, resumo),
        )

    @staticmethod
    def get_seating(code: str) -> PublicSeating:
        """Quadro de MESAS E ASSENTOS do dia do código: quem senta em que mesa
        e assento, em ordem alfabética, para o jogador achar a sua cadeira na
        TV do salão (pedido do NSOP para o dia final; vale para qualquer dia).

        Só pelo CÓDIGO (a credencial da TV), nunca pelo id do dia. Quem foi
        eliminado já não tem assento (a eliminação libera a cadeira), então a
        lista é sempre a de quem está jogando.
        """
        code = (code or "").strip().upper()
        # Várias TVs com o mesmo código, a cada 20 s: uma leitura serve todas
        # por até 10 s. Código inválido (404) não é guardado.
        return _quadro_de_mesas.obter(code, lambda: PublicTvService._montar_quadro(code))

    @staticmethod
    def _montar_quadro(code: str) -> PublicSeating:
        dias = []
        if code:
            dias = (
                supabase_admin.table("tournament_days")
                .select("id, day_name, tournament_id, organization_id")
                .eq("broadcast_code", code)
                .limit(1)
                .execute()
                .data
                or []
            )
        if not dias:
            raise ErroDeNegocio("codigo_de_tv_invalido", "Código inválido", status=404)
        dia = dias[0]
        day_id = str(dia["id"])
        org_id = dia.get("organization_id")

        torneio = (
            supabase_admin.table("tournaments").select("name")
            .eq("id", dia.get("tournament_id")).limit(1).execute().data
            or [{}]
        )[0]
        alocacoes = (
            supabase_admin.table("seat_allocations")
            .select("seat_number, player_id, tournament_tables(table_number), players(name)")
            .eq("tournament_day_id", day_id)
            .execute()
            .data
            or []
        )
        fichas = PublicTvService._fichas_classificadas(day_id)

        assentos = []
        for a in alocacoes:
            mesa = (a.get("tournament_tables") or {}).get("table_number")
            nome = ((a.get("players") or {}).get("name") or "").strip()
            # Alternado (sem mesa) e assento sem número não entram no quadro.
            if mesa is None or a.get("seat_number") is None or not nome:
                continue
            assentos.append(PublicSeat(
                name=nome,
                table_number=int(mesa),
                seat_number=int(a["seat_number"]),
                chips=fichas.get(str(a.get("player_id"))),
            ))
        assentos.sort(key=lambda s: (s.name.casefold(), s.table_number, s.seat_number))

        return PublicSeating(
            day_id=day_id,
            tournament_name=torneio.get("name"),
            day_name=dia.get("day_name"),
            organization_name=ModuleService.org_name(org_id),
            language=PublicTvService._org_settings(org_id)["language"],
            seats=assentos,
        )

    @staticmethod
    def _fichas_classificadas(day_id: str) -> dict:
        """player_id -> fichas com que se classificou (entradas vindas de um
        classificatório ainda em jogo). Decorativo: falhou, o quadro sai sem
        fichas."""
        try:
            linhas = (
                supabase_admin.table("tournament_players")
                .select("player_id, total_chips, is_qualified_entry, status")
                .eq("tournament_day_id", day_id)
                .execute()
                .data
                or []
            )
        except Exception as exc:
            logger.warning("Fichas classificadas do dia %s não lidas para o telão: %s", day_id, exc)
            return {}
        return {
            str(l["player_id"]): int(l["total_chips"])
            for l in linhas
            if l.get("is_qualified_entry") and l.get("status") != "eliminated"
            and int(l.get("total_chips") or 0) > 0
        }

    @staticmethod
    def _revezamento(tournament_id: str) -> Optional[dict]:
        """Final por revezamento (torneio por equipes): as equipes da final com
        os integrantes na ordem. Torneio comum ou erro → None (o telão esconde
        o painel)."""
        try:
            torneio = (
                supabase_admin.table("tournaments").select("*")
                .eq("id", tournament_id).limit(1).execute().data or []
            )
            if not torneio or not torneio[0].get("team_mode"):
                return None
            equipes = [
                e for e in (
                    supabase_admin.table("tournament_teams").select("id, name, final_tp_id, stage1_rank")
                    .eq("tournament_id", tournament_id).execute().data or []
                ) if e.get("final_tp_id")
            ]
            if not equipes:
                return None
            membros = (
                supabase_admin.table("tournament_team_members").select("team_id, player_id, relay_order")
                .eq("tournament_id", tournament_id).execute().data or []
            )
            ids = sorted({str(m["player_id"]) for m in membros})
            jogadores = {
                str(j["id"]): j for j in (
                    supabase_admin.table("players").select("id, name, nickname").in_("id", ids).execute().data or []
                )
            } if ids else {}
            situacao = {
                str(l["id"]): l.get("status") for l in (
                    supabase_admin.table("tournament_players").select("id, status")
                    .in_("id", [str(e["final_tp_id"]) for e in equipes]).execute().data or []
                )
            }
        except Exception as exc:  # decorativo: nunca derruba o telão
            logger.warning("Revezamento do torneio %s não lido para o telão: %s", tournament_id, exc)
            return None

        def apelido(player_id: str) -> str:
            j = jogadores.get(str(player_id)) or {}
            if (j.get("nickname") or "").strip():
                return j["nickname"].strip()
            return ((j.get("name") or "").split() or ["—"])[0]

        times = []
        for e in sorted(equipes, key=lambda e: (e.get("stage1_rank") or 0, str(e["id"]))):
            delas = sorted(
                (m for m in membros if str(m["team_id"]) == str(e["id"])),
                key=lambda m: m.get("relay_order") or 0,
            )
            times.append({
                "name": e.get("name"),
                "eliminated": situacao.get(str(e["final_tp_id"])) == "eliminated",
                "members": [apelido(m["player_id"]) for m in delas],
            })
        return {"start_level": 1, "teams": times}

    @staticmethod
    def _buy_types(tournament_id: str, day_id: str) -> list[PublicTvBuyType]:
        """Meios de entrada ATIVOS do torneio, na ordem do Caixa, cada um com
        QUANTAS vendas houve por ele neste dia (vendas canceladas fora).

        Venda antiga sem meio cadastrado (buy_type_id nulo) entra na conta do
        primeiro meio ativo da mesma categoria — melhor que sumir. Falhou ou
        não há lista (torneio antigo, por etapa)? Vazio — o telão só esconde a
        linha."""
        try:
            resp = (
                supabase_admin.table("buy_types")
                .select("id, name, amount, category, active, sort_order")
                .eq("tournament_id", str(tournament_id))
                .order("sort_order")
                .execute()
            )
        except Exception as exc:  # decorativo: nunca derruba o telão
            logger.warning("Meios de entrada do torneio %s não lidos para o telão: %s", tournament_id, exc)
            return []
        ativos = [r for r in (resp.data or []) if r.get("active") is not False]
        if not ativos:
            return []

        contagem = PublicTvService._vendas_por_meio(day_id)
        primeiro_da_categoria: dict = {}
        for r in ativos:
            primeiro_da_categoria.setdefault(r.get("category") or "buy_in", str(r.get("id")))

        saida = []
        for r in ativos:
            bid = str(r.get("id"))
            categoria = r.get("category") or "buy_in"
            total = contagem.get(bid, 0)
            if primeiro_da_categoria.get(categoria) == bid:
                total += contagem.get(f"sem_meio:{categoria}", 0)
            saida.append(PublicTvBuyType(
                name=str(r.get("name") or "").strip() or "—",
                count=int(total),
                amount=float(r.get("amount") or 0),
                category=categoria,
            ))
        return saida

    @staticmethod
    def _vendas_por_meio(day_id: str) -> dict:
        """{buy_type_id: n} das vendas ATIVAS dos jogadores deste dia; a venda
        sem meio vai em `sem_meio:<categoria>`. Erro → {} (a linha mostra 0)."""
        try:
            jogadores = (
                supabase_admin.table("tournament_players")
                .select("id")
                .eq("tournament_day_id", str(day_id))
                .execute()
            )
            ids = [str(j["id"]) for j in (jogadores.data or []) if j.get("id")]
            if not ids:
                return {}
            contagem: dict = {}
            # Em lotes: a lista de ids vai na URL e um dia grande estouraria o limite.
            for inicio in range(0, len(ids), 150):
                lote = ids[inicio:inicio + 150]
                linhas = ler_transacoes_ativas(
                    lambda colunas, lote=lote: (
                        supabase_admin.table("transactions")
                        .select(colunas)
                        .in_("tournament_player_id", lote)
                        .in_("type", ["buy_in", "rebuy", "addon"])
                    ),
                    "buy_type_id, type, entry_count",
                )
                for linha in linhas:
                    chave = str(linha["buy_type_id"]) if linha.get("buy_type_id") \
                        else f"sem_meio:{linha.get('type') or 'buy_in'}"
                    # Entradas, não vendas: esta linha substitui os quadros de
                    # Entradas e Reentradas no telão, e precisa dar o mesmo número.
                    contagem[chave] = contagem.get(chave, 0) + entradas_da_venda(linha)
            return contagem
        except Exception as exc:  # decorativo: nunca derruba o telão
            logger.warning("Vendas por meio do dia %s não lidas para o telão: %s", day_id, exc)
            return {}

    # ── partes ────────────────────────────────────────────────────────────

    @staticmethod
    def _org_settings(org_id: Optional[str]) -> dict:
        """Moeda e idioma da ORGANIZAÇÃO do dia (não os de quem abriu a tela).
        A TV do salão não tem login, então o idioma do clube só chega a ela
        por aqui."""
        padrao = {"currency": MOEDA_PADRAO, "language": IDIOMA_PADRAO}
        if not org_id:
            return padrao
        try:
            # Cópia: o valor guardado é compartilhado entre requisições.
            return dict(_ajustes_do_clube.obter(org_id, lambda: PublicTvService._ler_ajustes(org_id)))
        except Exception as exc:  # decorativo: nunca derruba o telão
            # A falha NÃO fica guardada: o padrão (BRL/pt-BR) vale só para esta
            # vez — senão a TV de um clube peruano mostraria reais por 1 minuto.
            logger.warning("Ajustes da org %s não lidos para o telão: %s", org_id, exc)
            return padrao

    @staticmethod
    def _ler_ajustes(org_id: str) -> dict:
        padrao = {"currency": MOEDA_PADRAO, "language": IDIOMA_PADRAO}
        resp = (
            supabase_admin.table("app_settings")
            .select("currency, language")
            .eq("organization_id", org_id)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            return padrao
        row = rows[0] or {}
        return {
            "currency": row.get("currency") or MOEDA_PADRAO,
            "language": row.get("language") or IDIOMA_PADRAO,
        }

    @staticmethod
    def _resumo(tournament_id: str):
        """O resumo da premiação, lido UMA vez para o prizepool e o KO.
        Falhou? `None` — a TV cai no `prize_pool` do dia, e os prêmios
        continuam vindo (são buscados à parte)."""
        try:
            return PrizeAllocationService.get_prize_summary(tournament_id)
        except Exception as exc:
            logger.warning("Resumo de premiação do torneio %s indisponível para o telão: %s",
                           tournament_id, exc)
            return None

    @staticmethod
    def _prize_pool(resumo) -> Optional[float]:
        """Prize pool pelo mesmo cálculo da tela de premiação."""
        if resumo is None:
            return None
        # Posições + KO: o pozo que o salão viu entrar.
        total = getattr(resumo, "total_prize_pool", None)
        return float(total or resumo.available_prize_pool)

    @staticmethod
    def _garantido(resumo) -> Optional[float]:
        """Garantido do torneio. Sem resumo, `None`: zero diria que não há garantido."""
        if resumo is None:
            return None
        return float(getattr(resumo, "guaranteed_prize", None) or 0)

    @staticmethod
    def _ko(tournament_id: str, resumo) -> dict:
        """Pool KO e, no Mystery já iniciado, os envelopes que faltam sair."""
        formato = getattr(resumo, "ko_format", None) or "none"
        if resumo is None or formato == "none":
            return {"ko_format": "none", "ko_pool": None, "mystery_envelopes_left": None}
        restantes = None
        lista = []
        nivel = None
        if formato == "mystery":
            try:
                envelopes = (
                    supabase_admin.table("tournament_mystery_envelopes").select("value, drawn_at")
                    .eq("tournament_id", tournament_id).execute().data or []
                )
                # Sem envelopes = fase ainda não iniciada: nada a contar.
                if envelopes:
                    fechados = [e for e in envelopes if not e.get("drawn_at")]
                    restantes = len(fechados)
                    por_valor: dict = {}
                    for e in fechados:
                        v = float(e.get("value") or 0)
                        por_valor[v] = por_valor.get(v, 0) + 1
                    lista = [{"value": v, "count": c} for v, c in sorted(por_valor.items(), reverse=True)]
                else:
                    t = (
                        supabase_admin.table("tournaments").select("mystery_start_level")
                        .eq("id", tournament_id).limit(1).execute().data or []
                    )
                    nivel = (t[0] if t else {}).get("mystery_start_level")
            except Exception as exc:
                logger.warning("Envelopes Mystery do torneio %s não lidos para o telão: %s",
                               tournament_id, exc)
        fundo = getattr(resumo, "ko_fund", None)
        return {
            "ko_format": formato,
            "ko_pool": float(fundo if fundo is not None else (getattr(resumo, "ko_pool", 0) or 0)),
            "mystery_envelopes_left": restantes,
            "mystery_envelopes": lista,
            "mystery_start_level": nivel,
        }

    @staticmethod
    def _prizes(tournament_id: str) -> list[PublicTvPrize]:
        try:
            resp = (
                supabase_admin.table("prize_allocations")
                .select(_CAMPOS_DO_PREMIO)
                .eq("tournament_id", tournament_id)
                .order("position")
                .execute()
            )
        except Exception as exc:
            logger.warning("Prêmios do torneio %s não lidos para o telão: %s", tournament_id, exc)
            return []
        saida = []
        for row in resp.data or []:
            # Filtro em Python, não `.neq("visible", false)`: a semântica de
            # NULL no PostgREST excluiria linhas antigas sem o campo.
            if row.get("visible") is False:
                continue
            saida.append(PublicTvPrize(
                position=int(row.get("position") or 0),
                prize_amount=float(row.get("prize_amount") or 0),
                prize_type=row.get("prize_type") or "cash",
                vaga_target_tournament_id=_str_ou_none(row.get("vaga_target_tournament_id")),
                vaga_target_day_id=_str_ou_none(row.get("vaga_target_day_id")),
            ))
        return saida


def _str_ou_none(valor) -> Optional[str]:
    return str(valor) if valor is not None else None
