"""Ranking de pontos (Manual de Ranking NSOP): parâmetros do clube, o torneio
no ranking (pontuável, B oficial, posições premiadas), a oficialização que
congela os pontos, e a classificação por etapa e por temporada.

A conta está em `ranking_pontos_regras` (sem banco). Aqui fica só o que
depende dos dados.

De onde vem cada número do torneio:
  * N (jogadores únicos): pessoas distintas inscritas no torneio, em
    qualquer dia, sem as inscrições canceladas. Reentrada e o mesmo jogador
    no Dia 1A e no 1B contam UMA vez.
  * B (buy-in oficial, sem a taxa): o que a direção gravar no torneio; sem
    isso, o maior meio de entrada da categoria buy-in que vale 1 entrada (o
    preço "cheio" — a promoção é mais barata). A taxa é outra categoria.
  * T (posições premiadas): as linhas da premiação do torneio (1..T).
  * Posições: a DIREÇÃO confirma quem ficou em cada posição premiada ao
    oficializar. A proposta vem da premiação (o jogador pago naquela posição)
    e, na falta, da ordem de eliminação — que hoje não é confiável sozinha
    (ninguém recebe o 1º lugar, e no modo "em lote" não há posição nenhuma).

Uma vez oficializado, nada recalcula: mudar a premiação ou a eliminação
depois não mexe no ranking. Corrigir exige reabrir com motivo, e o log de
atividade guarda quem, quando, o antes e o depois.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

from app.database import supabase
from app.database.paginacao import todas_as_linhas
from app.services.ranking_pontos_regras import (
    RegrasDoRanking, classificar, fator_buy_in, fator_jogadores, pontos_brutos, arredondar,
    tabela_de_pontos, torneio_pontua,
)
from app.utils.erros import ErroDeNegocio

logger = logging.getLogger("uvicorn.error")

_COLUNAS_DO_TORNEIO = (
    "id, name, stage_id, organization_id, team_mode, is_satellite, created_at, "
    "ranking_scoring, ranking_buy_in, ranking_official_at, ranking_official_by, ranking_reopen_reason"
)
_LOTE = 200


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _em_lotes(ids: List[str]) -> Iterable[List[str]]:
    for i in range(0, len(ids), _LOTE):
        yield ids[i:i + _LOTE]


class RankingPontosService:

    _tabelas_ok: Optional[bool] = None

    # ── Guarda de migração ───────────────────────────────────────────────────

    @staticmethod
    def migrado() -> bool:
        """As tabelas do ranking existem? Cacheia só o SIM: enquanto a
        migração não chega, cada chamada confere de novo (barato) e passa a
        valer assim que for aplicada, sem reiniciar o backend."""
        if RankingPontosService._tabelas_ok:
            return True
        try:
            supabase.table("tournament_ranking_results").select("id").limit(1).execute()
            RankingPontosService._tabelas_ok = True
            return True
        except Exception:
            logger.warning("tournament_ranking_results indisponível; ranking de pontos aguardando a migração")
            return False

    @staticmethod
    def _exigir_migracao() -> None:
        if not RankingPontosService.migrado():
            raise ErroDeNegocio(
                "ranking_migracao_pendente",
                "O ranking de pontos ainda não foi ativado neste servidor (migração pendente).",
                503,
            )

    # ── Parâmetros do clube ──────────────────────────────────────────────────

    @staticmethod
    def _linha_de_regras(org_id: str) -> Optional[dict]:
        linhas = supabase.table("ranking_rules").select("*").eq("organization_id", org_id).execute().data or []
        return linhas[0] if linhas else None

    @staticmethod
    def regras(org_id: str) -> RegrasDoRanking:
        return RegrasDoRanking.da_linha(RankingPontosService._linha_de_regras(org_id))

    @staticmethod
    def obter_regras(org_id: str) -> dict:
        RankingPontosService._exigir_migracao()
        linha = RankingPontosService._linha_de_regras(org_id)
        return {**RegrasDoRanking.da_linha(linha).como_dict(), "personalizadas": linha is not None}

    @staticmethod
    def salvar_regras(org_id: str, dados: dict, user_id: Optional[str]) -> dict:
        RankingPontosService._exigir_migracao()
        atuais = RankingPontosService.regras(org_id).como_dict()
        novas = RegrasDoRanking.da_linha({**atuais, **{k: v for k, v in dados.items() if v is not None}})
        if min(novas.pontos_base, novas.jogadores_referencia, novas.buy_in_referencia,
               novas.jogadores_fator_minimo, novas.buy_in_fator_minimo) <= 0 or novas.minimo_de_jogadores < 1:
            raise ErroDeNegocio("ranking_regras_invalidas", "Os valores do ranking precisam ser maiores que zero.")
        if novas.jogadores_fator_minimo > novas.jogadores_fator_maximo \
                or novas.buy_in_fator_minimo > novas.buy_in_fator_maximo:
            raise ErroDeNegocio("ranking_regras_invalidas", "O piso de um fator não pode passar do teto.")
        linha = {**novas.como_linha(), "updated_by": user_id}
        if RankingPontosService._linha_de_regras(org_id):
            supabase.table("ranking_rules").update(linha).eq("organization_id", org_id).execute()
        else:
            supabase.table("ranking_rules").insert({"organization_id": org_id, **linha}).execute()
        return {**novas.como_dict(), "personalizadas": True}

    # ── O torneio ────────────────────────────────────────────────────────────

    @staticmethod
    def _torneio(tournament_id: str) -> dict:
        linhas = supabase.table("tournaments").select(_COLUNAS_DO_TORNEIO).eq("id", tournament_id).execute().data or []
        if not linhas:
            raise ErroDeNegocio("torneio_nao_encontrado", "Torneio não encontrado.", 404)
        return linhas[0]

    @staticmethod
    def _exigir_da_etapa(torneio: dict, stage_id: Optional[str]) -> None:
        if stage_id and torneio.get("stage_id") and str(torneio["stage_id"]) != str(stage_id):
            raise ErroDeNegocio("torneio_de_outra_etapa", "Este torneio é de outra etapa.", 409)

    @staticmethod
    def _inscritos(tournament_id: str) -> List[dict]:
        """As inscrições ativas do torneio (todos os dias), sem as canceladas."""
        linhas = todas_as_linhas(lambda: (
            supabase.table("tournament_players")
            .select("id, player_id, status, final_position")
            .eq("tournament_id", tournament_id)
            .order("id")
        ))
        return [l for l in linhas if l.get("player_id") and (l.get("status") or "") != "cancelled"]

    @staticmethod
    def _nomes(player_ids: Iterable[str]) -> Dict[str, str]:
        ids = sorted({str(p) for p in player_ids if p})
        nomes: Dict[str, str] = {}
        for lote in _em_lotes(ids):
            for p in supabase.table("players").select("id, name, nickname").in_("id", lote).execute().data or []:
                nomes[str(p["id"])] = p.get("name") or p.get("nickname") or ""
        return nomes

    @staticmethod
    def _premiacao(tournament_id: str) -> List[dict]:
        return sorted(
            supabase.table("prize_allocations")
            .select("position, player_id, prize_type")
            .eq("tournament_id", tournament_id)
            .execute().data or [],
            key=lambda p: int(p.get("position") or 0),
        )

    @staticmethod
    def buy_in_padrao(tournament_id: str) -> Optional[float]:
        """O maior meio de entrada de buy-in que vale 1 entrada: o preço
        anunciado (a promoção é mais barata; o "Doble" vale 2 entradas; a
        taxa é de outra categoria)."""
        meios = supabase.table("buy_types").select("amount, category, active, per_team, entry_count") \
            .eq("tournament_id", tournament_id).execute().data or []
        valores = [
            float(m["amount"]) for m in meios
            if m.get("category") == "buy_in" and m.get("active", True) is not False
            and not m.get("per_team") and int(m.get("entry_count") or 1) == 1 and float(m.get("amount") or 0) > 0
        ]
        if valores:
            return max(valores)
        dias = supabase.table("tournament_days").select("buy_in, day_type") \
            .eq("tournament_id", tournament_id).execute().data or []
        valores = [float(d["buy_in"]) for d in dias if d.get("day_type") != "final" and float(d.get("buy_in") or 0) > 0]
        return max(valores) if valores else None

    @staticmethod
    def _resultados_oficiais(tournament_ids: List[str]) -> List[dict]:
        resultados: List[dict] = []
        for lote in _em_lotes([str(t) for t in tournament_ids]):
            resultados += supabase.table("tournament_ranking_results").select("*") \
                .in_("tournament_id", lote).execute().data or []
        return resultados

    @staticmethod
    def situacao(tournament_id: str, org_id: str) -> dict:
        """Tudo que a aba Ranking do torneio mostra: N, B, T, a tabela de
        pontos, a proposta de posições (ou o resultado oficial) e os avisos."""
        RankingPontosService._exigir_migracao()
        torneio = RankingPontosService._torneio(tournament_id)
        regras = RankingPontosService.regras(org_id)
        inscritos = RankingPontosService._inscritos(tournament_id)
        premiacao = RankingPontosService._premiacao(tournament_id)
        unicos = len({str(i["player_id"]) for i in inscritos})
        premiados = len(premiacao)
        padrao = RankingPontosService.buy_in_padrao(tournament_id)
        buy_in = float(torneio["ranking_buy_in"]) if torneio.get("ranking_buy_in") else padrao
        nomes = RankingPontosService._nomes(i["player_id"] for i in inscritos)
        oficial = bool(torneio.get("ranking_official_at"))

        avisos = []
        if torneio.get("team_mode"):
            avisos.append("torneio_por_equipes")
        if torneio.get("is_satellite") or any(p.get("prize_type") == "vaga" for p in premiacao):
            avisos.append("satelite")
        if premiados == 0:
            avisos.append("sem_premiacao")
        elif [int(p.get("position") or 0) for p in premiacao] != list(range(1, premiados + 1)):
            avisos.append("premiacao_com_buracos")
        if not torneio_pontua(unicos, regras):
            avisos.append("poucos_jogadores")
        if not buy_in:
            avisos.append("sem_buy_in")

        if oficial:
            resultados = sorted(RankingPontosService._resultados_oficiais([tournament_id]),
                                key=lambda r: int(r["position"]))
            posicoes = [{
                "position": int(r["position"]), "player_id": r["player_id"], "player_name": r.get("player_name"),
                "points": int(r.get("points") or 0), "source": "oficial",
            } for r in resultados]
            if resultados:
                unicos = int(resultados[0]["unique_players"])
                buy_in = float(resultados[0]["buy_in"])
                premiados = int(resultados[0]["paid_places"])
        else:
            pontos_por_posicao = {
                linha["position"]: linha["points"]
                for linha in tabela_de_pontos(unicos, buy_in or 0, premiados, regras)
            } if buy_in else {}
            posicoes = RankingPontosService._proposta(premiacao, inscritos, nomes, pontos_por_posicao)

        return {
            "tournament": {"id": torneio["id"], "name": torneio.get("name"), "stage_id": torneio.get("stage_id")},
            "scoring": bool(torneio.get("ranking_scoring")),
            "buy_in": buy_in,
            "buy_in_custom": float(torneio["ranking_buy_in"]) if torneio.get("ranking_buy_in") else None,
            "buy_in_default": padrao,
            "unique_players": unicos,
            "paid_places": premiados,
            "min_unique_players": regras.minimo_de_jogadores,
            "players_factor": round(fator_jogadores(unicos, regras), 5),
            "buy_in_factor": round(fator_buy_in(buy_in or 0, regras), 5) if buy_in else None,
            "official_at": torneio.get("ranking_official_at"),
            "official_by": torneio.get("ranking_official_by"),
            "reopen_reason": torneio.get("ranking_reopen_reason"),
            "positions": posicoes,
            "players": sorted(
                [{"id": pid, "name": nome} for pid, nome in nomes.items()],
                key=lambda p: (p["name"] or "").lower(),
            ),
            "warnings": avisos,
        }

    @staticmethod
    def _proposta(premiacao: List[dict], inscritos: List[dict], nomes: Dict[str, str],
                  pontos_por_posicao: Dict[int, int]) -> List[dict]:
        """Quem ficou em cada posição premiada, como sugestão: o jogador pago
        naquela posição; sem ele, quem a eliminação colocou lá (se for uma
        pessoa só). A direção confirma ou troca antes de oficializar."""
        por_eliminacao: Dict[int, set] = {}
        for i in inscritos:
            if i.get("final_position"):
                por_eliminacao.setdefault(int(i["final_position"]), set()).add(str(i["player_id"]))
        proposta = []
        for p in premiacao:
            posicao = int(p.get("position") or 0)
            jogador, origem = (str(p["player_id"]), "premiacao") if p.get("player_id") else (None, None)
            if not jogador and len(por_eliminacao.get(posicao, ())) == 1:
                jogador, origem = next(iter(por_eliminacao[posicao])), "eliminacao"
            proposta.append({
                "position": posicao,
                "player_id": jogador,
                "player_name": nomes.get(jogador) if jogador else None,
                "points": pontos_por_posicao.get(posicao, 0),
                "source": origem,
            })
        return proposta

    @staticmethod
    def configurar(tournament_id: str, dados: dict, stage_id: Optional[str]) -> dict:
        """Liga/desliga "pontuável" e grava o B oficial. Depois de
        oficializado, só reabrindo."""
        RankingPontosService._exigir_migracao()
        torneio = RankingPontosService._torneio(tournament_id)
        RankingPontosService._exigir_da_etapa(torneio, stage_id)
        if torneio.get("ranking_official_at"):
            raise ErroDeNegocio("ranking_ja_oficializado",
                                "Os resultados deste torneio já foram oficializados. Reabra para mudar.", 409)
        mudancas = {}
        if dados.get("scoring") is not None:
            mudancas["ranking_scoring"] = bool(dados["scoring"])
        if "buy_in" in dados:
            valor = dados["buy_in"]
            if valor is not None and float(valor) <= 0:
                raise ErroDeNegocio("ranking_buy_in_invalido", "O buy-in oficial precisa ser maior que zero.")
            mudancas["ranking_buy_in"] = float(valor) if valor is not None else None
        if mudancas:
            supabase.table("tournaments").update(mudancas).eq("id", tournament_id).execute()
        return RankingPontosService.situacao(tournament_id, torneio.get("organization_id"))

    @staticmethod
    def oficializar(tournament_id: str, posicoes: List[dict], org_id: str, user_id: Optional[str],
                    stage_id: Optional[str] = None) -> dict:
        """Confere as posições premiadas e congela os pontos."""
        RankingPontosService._exigir_migracao()
        torneio = RankingPontosService._torneio(tournament_id)
        RankingPontosService._exigir_da_etapa(torneio, stage_id)
        if torneio.get("ranking_official_at"):
            raise ErroDeNegocio("ranking_ja_oficializado", "Os resultados deste torneio já foram oficializados.", 409)
        if not torneio.get("ranking_scoring"):
            raise ErroDeNegocio("torneio_nao_pontuavel", "Marque o torneio como pontuável antes de oficializar.")

        premiados = len(RankingPontosService._premiacao(tournament_id))
        if premiados == 0:
            raise ErroDeNegocio("ranking_sem_premiacao",
                                "O torneio não tem premiação: sem as posições premiadas não há pontos.")
        buy_in = float(torneio["ranking_buy_in"]) if torneio.get("ranking_buy_in") \
            else RankingPontosService.buy_in_padrao(tournament_id)
        if not buy_in:
            raise ErroDeNegocio("ranking_sem_buy_in", "Informe o buy-in oficial do torneio.")

        por_posicao: Dict[int, str] = {}
        for item in posicoes or []:
            posicao = int(item.get("position") or 0)
            jogador = str(item.get("player_id") or "").strip()
            if posicao < 1 or posicao > premiados:
                raise ErroDeNegocio("ranking_posicao_fora_do_itm",
                                    f"A posição {posicao} não é premiada (o torneio premia {premiados}).",
                                    position=posicao, paid_places=premiados)
            if not jogador:
                continue
            if posicao in por_posicao:
                raise ErroDeNegocio("ranking_posicao_repetida", f"A posição {posicao} veio duas vezes.",
                                    position=posicao)
            por_posicao[posicao] = jogador
        faltando = [p for p in range(1, premiados + 1) if p not in por_posicao]
        if faltando:
            raise ErroDeNegocio("ranking_posicao_sem_jogador",
                                f"Falta o jogador da posição {faltando[0]}.", position=faltando[0])
        repetidos = {j for j in por_posicao.values() if list(por_posicao.values()).count(j) > 1}
        if repetidos:
            raise ErroDeNegocio("ranking_jogador_repetido", "O mesmo jogador está em duas posições.")

        inscritos = RankingPontosService._inscritos(tournament_id)
        ids_inscritos = {str(i["player_id"]) for i in inscritos}
        fora = [j for j in por_posicao.values() if j not in ids_inscritos]
        if fora:
            raise ErroDeNegocio("ranking_jogador_nao_inscrito", "Há jogador nas posições que não jogou este torneio.")

        regras = RankingPontosService.regras(org_id)
        unicos = len(ids_inscritos)
        nomes = RankingPontosService._nomes(por_posicao.values())
        fj = fator_jogadores(unicos, regras)
        fb = fator_buy_in(buy_in, regras)
        linhas = []
        for posicao in range(1, premiados + 1):
            bruto = pontos_brutos(posicao, unicos, buy_in, premiados, regras)
            linhas.append({
                "organization_id": org_id,
                "tournament_id": tournament_id,
                "player_id": por_posicao[posicao],
                "player_name": nomes.get(por_posicao[posicao]) or "",
                "position": posicao,
                "points": arredondar(bruto),
                "raw_points": round(bruto, 4),
                "unique_players": unicos,
                "buy_in": buy_in,
                "paid_places": premiados,
                "players_factor": round(fj, 5),
                "buy_in_factor": round(fb, 5),
                "official_by": user_id,
            })

        supabase.table("tournament_ranking_results").insert(linhas).execute()
        try:
            supabase.table("tournaments").update({
                "ranking_official_at": _agora(),
                "ranking_official_by": user_id,
            }).eq("id", tournament_id).execute()
        except Exception:
            # Sem o carimbo, a foto ficaria órfã e bloquearia a próxima tentativa.
            supabase.table("tournament_ranking_results").delete().eq("tournament_id", tournament_id).execute()
            raise
        return RankingPontosService.situacao(tournament_id, org_id)

    @staticmethod
    def reabrir(tournament_id: str, motivo: str, org_id: str, stage_id: Optional[str] = None) -> dict:
        """Desfaz a oficialização para corrigir. O motivo é obrigatório e fica
        no torneio (e no log de atividade, com quem e quando)."""
        RankingPontosService._exigir_migracao()
        motivo = (motivo or "").strip()
        if len(motivo) < 5:
            raise ErroDeNegocio("ranking_motivo_obrigatorio", "Diga o motivo da correção (ao menos 5 letras).")
        torneio = RankingPontosService._torneio(tournament_id)
        RankingPontosService._exigir_da_etapa(torneio, stage_id)
        if not torneio.get("ranking_official_at"):
            raise ErroDeNegocio("ranking_nao_oficializado", "Os resultados deste torneio não estão oficializados.", 409)
        supabase.table("tournament_ranking_results").delete().eq("tournament_id", tournament_id).execute()
        supabase.table("tournaments").update({
            "ranking_official_at": None,
            "ranking_official_by": None,
            "ranking_reopen_reason": motivo,
        }).eq("id", tournament_id).execute()
        return RankingPontosService.situacao(tournament_id, org_id)

    # ── Classificação ────────────────────────────────────────────────────────

    @staticmethod
    def _datas_dos_torneios(tournament_ids: List[str]) -> Dict[str, str]:
        datas: Dict[str, str] = {}
        for lote in _em_lotes(tournament_ids):
            for d in supabase.table("tournament_days").select("tournament_id, tournament_date") \
                    .in_("tournament_id", lote).execute().data or []:
                quando = d.get("tournament_date")
                tid = str(d["tournament_id"])
                if quando and (tid not in datas or str(quando) < datas[tid]):
                    datas[tid] = str(quando)
        return datas

    @staticmethod
    def _classificacao(torneios: List[dict], melhores: Optional[int]) -> dict:
        oficiais = [t for t in torneios if t.get("ranking_official_at")]
        ids = [str(t["id"]) for t in oficiais]
        datas = RankingPontosService._datas_dos_torneios(ids) if ids else {}
        resultados = RankingPontosService._resultados_oficiais(ids) if ids else []
        for r in resultados:
            r["tournament_date"] = datas.get(str(r["tournament_id"]), "")

        info: Dict[str, dict] = {}
        for r in resultados:
            info.setdefault(str(r["tournament_id"]), {
                "unique_players": r.get("unique_players"), "buy_in": r.get("buy_in"), "paid_places": r.get("paid_places"),
            })
        colunas = sorted(
            [{
                "id": str(t["id"]),
                "name": t.get("name"),
                "stage_id": t.get("stage_id"),
                "date": datas.get(str(t["id"])) or (str(t.get("created_at") or "")[:10] or None),
                "official_at": t.get("ranking_official_at"),
                **info.get(str(t["id"]), {}),
            } for t in oficiais],
            key=lambda c: (c.get("date") or "", c.get("name") or ""),
        )
        pendentes = [
            {"id": str(t["id"]), "name": t.get("name"), "stage_id": t.get("stage_id")}
            for t in torneios if t.get("ranking_scoring") and not t.get("ranking_official_at")
        ]
        linhas = classificar(resultados, melhores=melhores)
        return {
            "tournaments": colunas,
            "pending": pendentes,
            "best_results": melhores,
            "standings": [{
                "position": l.posicao, "tied": l.empatado,
                "player_id": l.player_id, "player_name": l.player_name,
                "total": l.total, "events": l.eventos, "counted": l.contados,
                "firsts": l.primeiros, "seconds": l.segundos, "thirds": l.terceiros,
                "final_tables": l.mesas_finais, "best": l.melhor_resultado,
                "by_tournament": l.por_torneio, "discarded": l.descartados,
            } for l in linhas],
        }

    @staticmethod
    def _torneios_das_etapas(stage_ids: List[str]) -> List[dict]:
        torneios: List[dict] = []
        for lote in _em_lotes([str(s) for s in stage_ids]):
            torneios += supabase.table("tournaments").select(_COLUNAS_DO_TORNEIO) \
                .in_("stage_id", lote).execute().data or []
        return torneios

    @staticmethod
    def ranking_da_etapa(stage_id: str) -> dict:
        RankingPontosService._exigir_migracao()
        etapas = supabase.table("stages").select("id, name, start_date, end_date").eq("id", stage_id).execute().data or []
        if not etapas:
            raise ErroDeNegocio("etapa_nao_encontrada", "Etapa não encontrada.", 404)
        return {
            "stage": etapas[0],
            **RankingPontosService._classificacao(RankingPontosService._torneios_das_etapas([stage_id]), None),
        }

    # ── Temporadas ───────────────────────────────────────────────────────────

    @staticmethod
    def _etapas_da_temporada(season_ids: List[str]) -> Dict[str, List[str]]:
        por_temporada: Dict[str, List[str]] = {str(s): [] for s in season_ids}
        for lote in _em_lotes([str(s) for s in season_ids]):
            for v in supabase.table("ranking_season_stages").select("season_id, stage_id") \
                    .in_("season_id", lote).execute().data or []:
                por_temporada.setdefault(str(v["season_id"]), []).append(str(v["stage_id"]))
        return por_temporada

    @staticmethod
    def listar_temporadas(org_id: str) -> List[dict]:
        RankingPontosService._exigir_migracao()
        temporadas = supabase.table("ranking_seasons").select("*").eq("organization_id", org_id) \
            .order("created_at", desc=True).execute().data or []
        etapas = RankingPontosService._etapas_da_temporada([t["id"] for t in temporadas])
        return [{**t, "stage_ids": etapas.get(str(t["id"]), [])} for t in temporadas]

    @staticmethod
    def _temporada(season_id: str) -> dict:
        linhas = supabase.table("ranking_seasons").select("*").eq("id", season_id).execute().data or []
        if not linhas:
            raise ErroDeNegocio("temporada_nao_encontrada", "Temporada não encontrada.", 404)
        return linhas[0]

    @staticmethod
    def _validar_temporada(dados: dict) -> None:
        if "name" in dados and not (dados.get("name") or "").strip():
            raise ErroDeNegocio("temporada_sem_nome", "Dê um nome à temporada.")
        melhores = dados.get("best_results")
        if melhores is not None and not 1 <= int(melhores) <= 100:
            raise ErroDeNegocio("temporada_melhores_invalido", "Os melhores resultados vão de 1 a 100.")

    @staticmethod
    def _gravar_etapas(season_id: str, org_id: str, stage_ids: List[str]) -> None:
        desejadas = {str(s) for s in stage_ids}
        atuais = set(RankingPontosService._etapas_da_temporada([season_id]).get(str(season_id), []))
        for stage_id in atuais - desejadas:
            supabase.table("ranking_season_stages").delete() \
                .eq("season_id", season_id).eq("stage_id", stage_id).execute()
        novas = sorted(desejadas - atuais)
        if novas:
            supabase.table("ranking_season_stages").insert([
                {"organization_id": org_id, "season_id": season_id, "stage_id": s} for s in novas
            ]).execute()

    @staticmethod
    def criar_temporada(org_id: str, dados: dict, user_id: Optional[str]) -> dict:
        RankingPontosService._exigir_migracao()
        RankingPontosService._validar_temporada({"name": dados.get("name"), **dados})
        criada = supabase.table("ranking_seasons").insert({
            "organization_id": org_id,
            "name": dados["name"].strip(),
            "best_results": dados.get("best_results"),
            "status": dados.get("status") or "active",
            "created_by": user_id,
            "updated_by": user_id,
        }).execute().data[0]
        RankingPontosService._gravar_etapas(criada["id"], org_id, dados.get("stage_ids") or [])
        return {**criada, "stage_ids": sorted({str(s) for s in dados.get("stage_ids") or []})}

    @staticmethod
    def atualizar_temporada(season_id: str, org_id: str, dados: dict, user_id: Optional[str]) -> dict:
        RankingPontosService._exigir_migracao()
        RankingPontosService._temporada(season_id)
        RankingPontosService._validar_temporada(dados)
        mudancas = {"updated_by": user_id}
        if "name" in dados:
            mudancas["name"] = dados["name"].strip()
        if "best_results" in dados:
            mudancas["best_results"] = dados["best_results"]
        if dados.get("status") in ("active", "closed"):
            mudancas["status"] = dados["status"]
        supabase.table("ranking_seasons").update(mudancas).eq("id", season_id).execute()
        if dados.get("stage_ids") is not None:
            RankingPontosService._gravar_etapas(season_id, org_id, dados["stage_ids"])
        temporada = RankingPontosService._temporada(season_id)
        etapas = RankingPontosService._etapas_da_temporada([season_id]).get(str(season_id), [])
        return {**temporada, "stage_ids": etapas}

    @staticmethod
    def excluir_temporada(season_id: str) -> None:
        RankingPontosService._exigir_migracao()
        RankingPontosService._temporada(season_id)
        supabase.table("ranking_season_stages").delete().eq("season_id", season_id).execute()
        supabase.table("ranking_seasons").delete().eq("id", season_id).execute()

    @staticmethod
    def ranking_da_temporada(season_id: str) -> dict:
        RankingPontosService._exigir_migracao()
        temporada = RankingPontosService._temporada(season_id)
        etapas = RankingPontosService._etapas_da_temporada([season_id]).get(str(season_id), [])
        torneios = RankingPontosService._torneios_das_etapas(etapas) if etapas else []
        return {
            "season": {**temporada, "stage_ids": etapas},
            **RankingPontosService._classificacao(torneios, temporada.get("best_results")),
        }
