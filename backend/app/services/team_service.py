"""Torneio por equipes: cadastro, sorteio de mesas, pontos da Fase 1 e a final
por revezamento.

As contas moram em `equipes_regras` (funções puras); aqui fica o que toca o banco.

Estrutura (migração `database_migration_torneio_equipes.sql`):
- Fase 1 = o dia CLASSIFICATÓRIO do torneio (modo mesa); Fase 2 = o dia FINAL.
- `tournament_teams` / `tournament_team_members`: as equipes e a ordem do
  revezamento.
- `tournament_team_results`: FATOS da Fase 1, uma linha por eliminação (mesa
  no momento em que o jogador caiu, hora, "empate com o anterior", posição
  digitada). Pontos e ranking são calculados na LEITURA; a linha só vale
  enquanto o jogador está eliminado, então desfazer eliminação, reentrada e
  estorno não precisam de gancho. "Oficializar" congela a foto.
- Na final cada equipe é UMA inscrição (a do capitão) com o stack da equipe.

`organization_id` vai EXPLÍCITO nas linhas novas, copiado do torneio: o replay
do modo offline roda com a service_role, onde `current_org_id()` é nulo.
"""
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Dict, Iterable, List, Optional, Tuple

from app.database import supabase
from app.services import equipes_regras as R
from app.utils.erros import ErroDeNegocio

# id determinístico do resultado (dia + inscrição): o upsert da eliminação é
# idempotente no replay offline.
_NS_RESULTADO = uuid.UUID("6f1f3c3e-8a51-4c6b-9b7e-5f1d2a9c0e11")
_VIVOS = ("registered", "active")

# Quem é de qual equipe, por torneio. A alocação automática do Caixa consulta
# isto a CADA venda — num torneio comum a resposta é "ninguém", e sem cache
# seria uma ida ao banco (~270 ms) a mais por venda. Mudanças nas equipes
# limpam o cache na hora; 30 s cobrem outro processo.
_cache_membros: Dict[str, Tuple[float, Dict[str, str]]] = {}
_CACHE_SEGUNDOS = 30


def limpar_cache(tournament_id: Optional[str] = None) -> None:
    if tournament_id is None:
        _cache_membros.clear()
    else:
        _cache_membros.pop(str(tournament_id), None)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _quando(valor) -> datetime:
    """Data do banco (texto ISO) comparável; vazio vira o início dos tempos."""
    if not valor:
        return datetime.min.replace(tzinfo=timezone.utc)
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    texto = str(valor).replace("Z", "+00:00")
    try:
        data = datetime.fromisoformat(texto)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return data if data.tzinfo else data.replace(tzinfo=timezone.utc)


def id_do_resultado(day_id: str, tp_id: str) -> str:
    return str(uuid.uuid5(_NS_RESULTADO, f"{day_id}:{tp_id}"))


def _org(torneio: dict) -> dict:
    org = (torneio or {}).get("organization_id")
    return {"organization_id": org} if org else {}


def _num(valor) -> Optional[float]:
    return None if valor is None else float(valor)


class TeamService:
    # ── Leitura básica ──────────────────────────────────────────────────────
    @staticmethod
    def torneio(tournament_id: str) -> dict:
        linhas = supabase.table("tournaments").select("*").eq("id", str(tournament_id)).execute().data or []
        if not linhas:
            raise ErroDeNegocio("torneio_nao_encontrado", "Torneio não encontrado.", status=404)
        torneio = linhas[0]
        if not torneio.get("team_mode"):
            raise ErroDeNegocio(
                "torneio_nao_e_por_equipes", "Este torneio não é por equipes.", status=409,
            )
        return torneio

    @staticmethod
    def dias(tournament_id: str) -> Tuple[Optional[dict], Optional[dict]]:
        """(dia da Fase 1, dia da final). A Fase 1 é o classificatório; a final,
        o dia para onde ele classifica."""
        dias = (
            supabase.table("tournament_days").select("*")
            .eq("tournament_id", str(tournament_id)).order("day_number").execute().data or []
        )
        fase1 = next((d for d in dias if d.get("day_type") == "qualifying"), None)
        if fase1 is None:
            fase1 = next((d for d in dias if d.get("day_type") != "final"), None)
        final = None
        if fase1 and fase1.get("qualifies_to_day_id"):
            final = next((d for d in dias if str(d["id"]) == str(fase1["qualifies_to_day_id"])), None)
        if final is None:
            final = next((d for d in dias if d.get("day_type") == "final"), None)
        return fase1, final

    @staticmethod
    def membros_por_jogador(tournament_id: str) -> Dict[str, str]:
        """{player_id: team_id} do torneio (vazio num torneio comum)."""
        chave = str(tournament_id)
        agora = time.monotonic()
        em_cache = _cache_membros.get(chave)
        if em_cache and em_cache[0] > agora:
            return em_cache[1]
        try:
            linhas = (
                supabase.table("tournament_team_members").select("player_id, team_id")
                .eq("tournament_id", chave).execute().data or []
            )
        except Exception:
            # Banco sem a migração de equipes: ninguém é de equipe nenhuma.
            linhas = []
        mapa = {str(l["player_id"]): str(l["team_id"]) for l in linhas}
        _cache_membros[chave] = (agora + _CACHE_SEGUNDOS, mapa)
        return mapa

    @staticmethod
    def _carregar(tournament_id: str) -> Tuple[List[dict], List[dict]]:
        equipes = (
            supabase.table("tournament_teams").select("*")
            .eq("tournament_id", str(tournament_id)).order("created_at").execute().data or []
        )
        membros = (
            supabase.table("tournament_team_members").select("*")
            .eq("tournament_id", str(tournament_id)).order("relay_order").execute().data or []
        )
        return equipes, membros

    @staticmethod
    def _nomes(player_ids: Iterable[Optional[str]]) -> Dict[str, dict]:
        ids = sorted({str(p) for p in player_ids if p})
        if not ids:
            return {}
        linhas = supabase.table("players").select("id, name, nickname").in_("id", ids).execute().data or []
        return {str(l["id"]): l for l in linhas}

    @staticmethod
    def _inscricoes_do_dia(day_id: Optional[str]) -> List[dict]:
        if not day_id:
            return []
        return (
            supabase.table("tournament_players")
            .select("id, player_id, status, eliminated_at, is_qualified_entry, total_chips")
            .eq("tournament_day_id", str(day_id)).execute().data or []
        )

    @staticmethod
    def _equipe(tournament_id: str, team_id: str) -> dict:
        linhas = (
            supabase.table("tournament_teams").select("*")
            .eq("id", str(team_id)).eq("tournament_id", str(tournament_id)).execute().data or []
        )
        if not linhas:
            raise ErroDeNegocio("equipe_nao_encontrada", "Equipe não encontrada.", status=404)
        return linhas[0]

    @staticmethod
    def _recusar_se_oficializado(torneio: dict) -> None:
        if torneio.get("team_results_official_at"):
            raise ErroDeNegocio(
                "fase1_oficializada",
                "A Fase 1 já foi oficializada: desfaça a oficialização para mudar.",
                status=409,
            )

    # ── Cadastro ────────────────────────────────────────────────────────────
    @staticmethod
    def listar(tournament_id: str) -> dict:
        torneio = TeamService.torneio(tournament_id)
        fase1, final = TeamService.dias(tournament_id)
        equipes, membros = TeamService._carregar(tournament_id)
        inscricoes = {
            str(t["player_id"]): t for t in TeamService._inscricoes_do_dia((fase1 or {}).get("id"))
            if t.get("status") != "cancelled"
        }
        nomes = TeamService._nomes(m["player_id"] for m in membros)
        saida = []
        for equipe in equipes:
            dela = [m for m in membros if str(m["team_id"]) == str(equipe["id"])]
            saida.append({
                "id": str(equipe["id"]),
                "name": equipe.get("name"),
                "captain_player_id": str(equipe.get("captain_player_id")),
                "final_tp_id": equipe.get("final_tp_id"),
                "tiebreak_rank": equipe.get("tiebreak_rank"),
                "captain_verified_at": equipe.get("captain_verified_at"),
                "stage1_points": _num(equipe.get("stage1_points")),
                "stage1_rank": equipe.get("stage1_rank"),
                "members": [
                    {
                        "player_id": str(m["player_id"]),
                        "name": (nomes.get(str(m["player_id"])) or {}).get("name"),
                        "nickname": (nomes.get(str(m["player_id"])) or {}).get("nickname"),
                        "relay_order": m.get("relay_order"),
                        "is_captain": str(m["player_id"]) == str(equipe.get("captain_player_id")),
                        "tp_id": (inscricoes.get(str(m["player_id"])) or {}).get("id"),
                        "status": (inscricoes.get(str(m["player_id"])) or {}).get("status"),
                    }
                    for m in sorted(dela, key=lambda m: m.get("relay_order") or 0)
                ],
            })
        return {
            "tournament": {
                "id": str(torneio["id"]),
                "name": torneio.get("name"),
                "team_finalists": torneio.get("team_finalists"),
                "team_tiebreak": torneio.get("team_tiebreak") or "best_individual",
                "team_allow_reentry": bool(torneio.get("team_allow_reentry")),
                "team_results_official_at": torneio.get("team_results_official_at"),
            },
            "stage1_day_id": (fase1 or {}).get("id"),
            "stage1_day_name": (fase1 or {}).get("day_name"),
            "final_day_id": (final or {}).get("id"),
            "final_day_name": (final or {}).get("day_name"),
            "final_started": bool((final or {}).get("timer_started_at")),
            "teams": saida,
        }

    @staticmethod
    def _nome_livre(tournament_id: str, nome: str, team_id: Optional[str] = None) -> None:
        equipes = (
            supabase.table("tournament_teams").select("id, name")
            .eq("tournament_id", str(tournament_id)).execute().data or []
        )
        alvo = nome.strip().lower()
        if any((e.get("name") or "").strip().lower() == alvo and str(e["id"]) != str(team_id) for e in equipes):
            raise ErroDeNegocio(
                "nome_de_equipe_repetido", f"Já existe uma equipe chamada {nome}.", status=409, nome=nome,
            )

    @staticmethod
    def _validar_integrantes(tournament_id: str, player_ids: List[str], capitao: str,
                             team_id: Optional[str] = None) -> None:
        ids = [str(p) for p in player_ids]
        if not ids or len(ids) > R.JOGADORES_POR_EQUIPE:
            raise ErroDeNegocio(
                "equipe_tamanho_invalido",
                f"Uma equipe tem de 1 a {R.JOGADORES_POR_EQUIPE} integrantes.",
                maximo=R.JOGADORES_POR_EQUIPE,
            )
        if len(set(ids)) != len(ids):
            raise ErroDeNegocio("integrante_repetido", "O mesmo jogador aparece duas vezes na equipe.")
        if str(capitao) not in ids:
            raise ErroDeNegocio("capitao_fora_da_equipe", "O capitão precisa ser um dos integrantes.")
        outros = (
            supabase.table("tournament_team_members").select("player_id, team_id")
            .eq("tournament_id", str(tournament_id)).in_("player_id", ids).execute().data or []
        )
        em_outra = [o for o in outros if str(o["team_id"]) != str(team_id)]
        if em_outra:
            nome = (TeamService._nomes([em_outra[0]["player_id"]]).get(str(em_outra[0]["player_id"])) or {}).get("name")
            raise ErroDeNegocio(
                "jogador_em_outra_equipe", f"{nome} já está em outra equipe deste torneio.",
                status=409, nome=nome,
            )

    @staticmethod
    def _recusar_quem_ja_jogou(tournament_id: str, player_ids: Iterable[str]) -> None:
        """Integrante que já caiu na Fase 1 tem pontos: tirá-lo da equipe
        mudaria o ranking por baixo dos panos."""
        ids = sorted({str(p) for p in player_ids})
        if not ids:
            return
        fase1, _ = TeamService.dias(tournament_id)
        if not fase1:
            return
        caidos = (
            supabase.table("tournament_players").select("player_id, status")
            .eq("tournament_day_id", str(fase1["id"])).in_("player_id", ids).execute().data or []
        )
        caidos = [c for c in caidos if c.get("status") == "eliminated"]
        if caidos:
            nome = (TeamService._nomes([caidos[0]["player_id"]]).get(str(caidos[0]["player_id"])) or {}).get("name")
            raise ErroDeNegocio(
                "membro_ja_jogou",
                f"{nome} já foi eliminado na Fase 1 e tem pontos: não pode sair da equipe.",
                status=409, nome=nome,
            )

    @staticmethod
    def criar(tournament_id: str, name: str, captain_player_id: str, player_ids: List[str]) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        nome = name.strip()
        TeamService._nome_livre(tournament_id, nome)
        TeamService._validar_integrantes(tournament_id, player_ids, captain_player_id)
        equipe = supabase.table("tournament_teams").insert({
            **_org(torneio),
            "tournament_id": str(tournament_id),
            "name": nome,
            "captain_player_id": str(captain_player_id),
        }).execute().data[0]
        try:
            supabase.table("tournament_team_members").insert([
                {
                    **_org(torneio),
                    "tournament_id": str(tournament_id),
                    "team_id": str(equipe["id"]),
                    "player_id": str(p),
                    "relay_order": i + 1,
                }
                for i, p in enumerate(player_ids)
            ]).execute()
        except Exception:
            supabase.table("tournament_teams").delete().eq("id", equipe["id"]).execute()
            raise
        limpar_cache(tournament_id)
        return TeamService.listar(tournament_id)

    @staticmethod
    def _gravar_integrantes(torneio: dict, team_id: str, novos: List[str], membros: List[dict]) -> None:
        por_jogador = {str(m["player_id"]): m for m in membros}
        saem = [m["id"] for m in membros if str(m["player_id"]) not in {str(p) for p in novos}]
        if saem:
            supabase.table("tournament_team_members").delete().in_("id", saem).execute()
        linhas = []
        for i, p in enumerate(novos):
            atual = por_jogador.get(str(p))
            linhas.append({
                "id": atual["id"] if atual else str(uuid.uuid4()),
                **_org(torneio),
                "tournament_id": str(torneio["id"]),
                "team_id": str(team_id),
                "player_id": str(p),
                "relay_order": i + 1,
            })
        # Um upsert só: a UNIQUE (equipe, ordem) é adiada, trocar as posições
        # entre si não colide no meio do caminho.
        supabase.table("tournament_team_members").upsert(linhas).execute()

    @staticmethod
    def editar(tournament_id: str, team_id: str, name: Optional[str] = None,
               captain_player_id: Optional[str] = None, player_ids: Optional[List[str]] = None) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        equipe = TeamService._equipe(tournament_id, team_id)
        membros = sorted(
            (supabase.table("tournament_team_members").select("*")
             .eq("team_id", str(team_id)).execute().data or []),
            key=lambda m: m.get("relay_order") or 0,
        )
        atuais = [str(m["player_id"]) for m in membros]
        novos = [str(p) for p in player_ids] if player_ids is not None else atuais
        capitao = str(captain_player_id or equipe.get("captain_player_id"))
        if player_ids is not None or captain_player_id is not None:
            TeamService._validar_integrantes(tournament_id, novos, capitao, team_id)
        TeamService._recusar_quem_ja_jogou(tournament_id, set(atuais) - set(novos))

        patch = {}
        if name is not None and name.strip() != (equipe.get("name") or ""):
            TeamService._nome_livre(tournament_id, name.strip(), team_id)
            patch["name"] = name.strip()
        if captain_player_id is not None:
            patch["captain_player_id"] = capitao
        if patch:
            patch["updated_at"] = _agora()
            supabase.table("tournament_teams").update(patch).eq("id", str(team_id)).execute()
        if player_ids is not None and novos != atuais:
            TeamService._gravar_integrantes(torneio, team_id, novos, membros)
        limpar_cache(tournament_id)
        return TeamService.listar(tournament_id)

    @staticmethod
    def excluir(tournament_id: str, team_id: str) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        equipe = TeamService._equipe(tournament_id, team_id)
        if equipe.get("final_tp_id"):
            raise ErroDeNegocio("equipe_na_final", "Esta equipe já está na final.", status=409)
        membros = supabase.table("tournament_team_members").select("player_id").eq("team_id", str(team_id)).execute().data or []
        TeamService._recusar_quem_ja_jogou(tournament_id, [m["player_id"] for m in membros])
        supabase.table("tournament_teams").delete().eq("id", str(team_id)).execute()
        limpar_cache(tournament_id)
        return TeamService.listar(tournament_id)

    @staticmethod
    def definir_ordem(tournament_id: str, team_id: str, player_ids: List[str], force: bool = False) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._equipe(tournament_id, team_id)
        membros = supabase.table("tournament_team_members").select("*").eq("team_id", str(team_id)).execute().data or []
        ids = [str(p) for p in player_ids]
        if len(set(ids)) != len(ids) or set(ids) != {str(m["player_id"]) for m in membros}:
            raise ErroDeNegocio(
                "ordem_com_outros_jogadores",
                "A ordem do revezamento precisa ter exatamente os integrantes da equipe.",
            )
        _, final = TeamService.dias(tournament_id)
        if final and final.get("timer_started_at") and not force:
            raise ErroDeNegocio(
                "ordem_de_revezamento_travada",
                "A final já começou: a ordem do revezamento não muda mais.",
                status=409,
            )
        TeamService._gravar_integrantes(torneio, team_id, ids, membros)
        return TeamService.listar(tournament_id)

    # ── Mesas: a restrição "colegas em mesas diferentes" ───────────────────
    @staticmethod
    def colegas(tournament_id: str, player_id: str) -> List[str]:
        mapa = TeamService.membros_por_jogador(tournament_id)
        equipe = mapa.get(str(player_id))
        if not equipe:
            return []
        return [p for p, e in mapa.items() if e == equipe and p != str(player_id)]

    @staticmethod
    def mesas_com_colega(tournament_id: str, player_id: str, alocacoes: Iterable[dict]) -> set:
        """Mesas onde já está sentado um colega de equipe (alocação automática)."""
        colegas = set(TeamService.colegas(tournament_id, player_id))
        if not colegas:
            return set()
        return {str(a["table_id"]) for a in alocacoes if str(a.get("player_id")) in colegas}

    @staticmethod
    def recusar_mesa_com_colega(tournament_id: str, player_id: str, table_id: str) -> None:
        """Sentar à mão (ou trocar de mesa) ao lado de um colega é recusado."""
        colegas = TeamService.colegas(tournament_id, player_id)
        if not colegas:
            return
        na_mesa = (
            supabase.table("seat_allocations").select("player_id")
            .eq("table_id", str(table_id)).in_("player_id", colegas).execute().data or []
        )
        if not na_mesa:
            return
        nome = (TeamService._nomes([na_mesa[0]["player_id"]]).get(str(na_mesa[0]["player_id"])) or {}).get("name")
        mesa = supabase.table("tournament_tables").select("table_number").eq("id", str(table_id)).execute().data or []
        numero = (mesa[0] if mesa else {}).get("table_number")
        raise ErroDeNegocio(
            "mesa_com_companheiro",
            f"{nome}, da mesma equipe, já está na mesa {numero}.",
            status=409, companheiro=nome, mesa=numero,
        )

    @staticmethod
    def sortear_mesas(tournament_id: str, day_id: Optional[str] = None, refazer: bool = False,
                      somente: Optional[Iterable[str]] = None) -> dict:
        """Sorteia as mesas da Fase 1 separando os integrantes de cada equipe
        (ver `equipes_regras.distribuir_por_mesas`); o lugar na mesa é sorteado."""
        from app.services.allocation_service import AllocationService, _assentos_livres, _sorteio

        TeamService.torneio(tournament_id)
        if not day_id:
            fase1, _ = TeamService.dias(tournament_id)
            day_id = (fase1 or {}).get("id")
        if not day_id:
            raise ErroDeNegocio("torneio_sem_dia_da_fase1", "Crie o dia da Fase 1 antes de sortear as mesas.")
        inscricoes = [t for t in TeamService._inscricoes_do_dia(day_id) if not t.get("is_qualified_entry")]
        if refazer:
            if any(t.get("status") == "eliminated" for t in inscricoes):
                raise ErroDeNegocio(
                    "sorteio_com_eliminacoes",
                    "Já houve eliminações neste dia: o sorteio não pode ser refeito.",
                    status=409,
                )
            supabase.table("seat_allocations").delete().eq("tournament_day_id", str(day_id)).execute()

        mesas = (
            supabase.table("tournament_tables").select("*")
            .eq("tournament_day_id", str(day_id)).eq("status", "active")
            .order("table_number").execute().data or []
        )
        if not mesas:
            raise ErroDeNegocio("sem_mesas_ativas", "Crie as mesas do dia antes de sortear.")
        alocacoes = (
            supabase.table("seat_allocations").select("player_id, table_id, seat_number")
            .eq("tournament_day_id", str(day_id)).execute().data or []
        )
        ocupados: Dict[str, set] = {str(m["id"]): set() for m in mesas}
        mesa_do_sentado: Dict[str, str] = {}
        for a in alocacoes:
            mesa_do_sentado[str(a["player_id"])] = str(a["table_id"])
            if str(a["table_id"]) in ocupados:
                ocupados[str(a["table_id"])].add(a["seat_number"])

        a_sentar = [
            str(t["player_id"]) for t in inscricoes
            if t.get("status") in _VIVOS and str(t["player_id"]) not in mesa_do_sentado
        ]
        if somente:
            filtro = {str(p) for p in somente}
            a_sentar = [p for p in a_sentar if p in filtro]

        mapa = TeamService.membros_por_jogador(tournament_id)
        equipes: Dict[str, dict] = {}
        avulsos: List[str] = []
        for p in a_sentar:
            equipe = mapa.get(p)
            if not equipe:
                avulsos.append(p)
                continue
            equipes.setdefault(equipe, {"id": equipe, "a_sentar": [], "proibidas": set()})["a_sentar"].append(p)
        for p, equipe in mapa.items():
            if equipe in equipes and p in mesa_do_sentado:
                equipes[equipe]["proibidas"].add(mesa_do_sentado[p])

        entrada = []
        for m in mesas:
            mid = str(m["id"])
            utilizaveis = int(m.get("seats") or 0) - len(m.get("blocked_seats") or [])
            entrada.append({
                "id": mid,
                "table_number": m.get("table_number"),
                "ocupados": len(ocupados[mid]),
                "capacidade": max(0, min(R.MAX_POR_MESA, utilizaveis) - len(ocupados[mid])),
            })
        mesa_de = R.distribuir_por_mesas(list(equipes.values()), avulsos, entrada, _sorteio)

        por_id = {str(m["id"]): m for m in mesas}
        pendentes = []
        for jogador, mid in mesa_de.items():
            livres = _assentos_livres(por_id[mid], ocupados[mid])
            assento = _sorteio.choice(livres)
            ocupados[mid].add(assento)
            pendentes.append({
                "tournament_id": str(tournament_id),
                "tournament_day_id": str(day_id),
                "player_id": jogador,
                "table_id": mid,
                "seat_number": assento,
            })
        inseridos = []
        if pendentes:
            inseridos = supabase.table("seat_allocations").insert(pendentes).execute().data or []
        AllocationService._sync_table_counts(mesas, {mid: len(s) for mid, s in ocupados.items()})
        return {"allocated": len(inseridos), "allocations": inseridos}

    # ── Fase 1: o gancho da eliminação ──────────────────────────────────────
    @staticmethod
    def registrar_eliminacao_fase1(tp: dict, torneio: dict, quando: Optional[str], user_id: Optional[str] = None,
                                   so_se_faltar: bool = False) -> None:
        """Grava a MESA em que o jogador caiu — chamado ANTES de a cadeira ser
        liberada (depois dela não há mais como saber). A linha da equipe na
        final (`is_qualified_entry`) não pontua."""
        if not (torneio or {}).get("team_mode") or tp.get("is_qualified_entry"):
            return
        day_id = tp.get("tournament_day_id")
        if not day_id:
            return
        rid = id_do_resultado(day_id, tp["id"])
        if so_se_faltar:
            if supabase.table("tournament_team_results").select("id").eq("id", rid).execute().data:
                return
        assento = (
            supabase.table("seat_allocations").select("table_id")
            .eq("tournament_day_id", str(day_id)).eq("player_id", str(tp["player_id"])).execute().data or []
        )
        supabase.table("tournament_team_results").upsert({
            "id": rid,
            **_org(torneio),
            "tournament_id": str(tp["tournament_id"]),
            "tournament_day_id": str(day_id),
            "tournament_player_id": str(tp["id"]),
            "player_id": str(tp["player_id"]),
            "table_id": assento[0]["table_id"] if assento else None,
            "eliminated_at": quando,
            "tie_with_previous": False,
            "manual_position": None,
            "position": None,
            "points": None,
            "table_size": None,
            "source": "auto",
            "updated_by": user_id,
            "updated_at": _agora(),
        }).execute()

    # ── Fase 1: leitura (pontos por mesa e ranking) ─────────────────────────
    @staticmethod
    def _dados_da_fase1(tournament_id: str) -> dict:
        torneio = TeamService.torneio(tournament_id)
        fase1, final = TeamService.dias(tournament_id)
        equipes, membros = TeamService._carregar(tournament_id)
        day_id = (fase1 or {}).get("id")
        inscricoes = [t for t in TeamService._inscricoes_do_dia(day_id) if not t.get("is_qualified_entry")]
        resultados, alocacoes, mesas = [], [], []
        if day_id:
            resultados = (
                supabase.table("tournament_team_results").select("*")
                .eq("tournament_day_id", str(day_id)).execute().data or []
            )
            alocacoes = (
                supabase.table("seat_allocations").select("player_id, table_id, seat_number")
                .eq("tournament_day_id", str(day_id)).execute().data or []
            )
            mesas = (
                supabase.table("tournament_tables").select("id, table_number, status")
                .eq("tournament_day_id", str(day_id)).execute().data or []
            )
        nomes = TeamService._nomes([t["player_id"] for t in inscricoes] + [m["player_id"] for m in membros])
        return {
            "torneio": torneio, "fase1": fase1, "final": final, "equipes": equipes, "membros": membros,
            "inscricoes": inscricoes, "resultados": resultados, "alocacoes": alocacoes, "mesas": mesas,
            "nomes": nomes,
        }

    @staticmethod
    def _montar_fase1(d: dict) -> dict:
        torneio, fase1, final = d["torneio"], d["fase1"], d["final"]
        oficial = bool(torneio.get("team_results_official_at"))
        tp_por_id = {str(t["id"]): t for t in d["inscricoes"] if t.get("status") != "cancelled"}
        tp_por_jogador = {str(t["player_id"]): t for t in tp_por_id.values()}
        equipe_do_jogador = {str(m["player_id"]): str(m["team_id"]) for m in d["membros"]}
        nome_da_equipe = {str(e["id"]): e.get("name") for e in d["equipes"]}
        capitaes = {str(e.get("captain_player_id")) for e in d["equipes"]}
        numero_da_mesa = {str(m["id"]): m.get("table_number") for m in d["mesas"]}
        nomes = d["nomes"]

        def valida(r):
            tp = tp_por_id.get(str(r.get("tournament_player_id")))
            if not tp:
                return False
            return tp.get("status") == "eliminated" or r.get("source") == "manual"

        resultados = [r for r in d["resultados"] if valida(r)]
        por_tp = {str(r["tournament_player_id"]): r for r in resultados}
        foto = {str(r["tournament_player_id"]): r for r in d["resultados"] if r.get("points") is not None}

        vivos_por_mesa: Dict[str, List[str]] = {}
        mesa_do_vivo: Dict[str, str] = {}
        for a in d["alocacoes"]:
            tp = tp_por_jogador.get(str(a["player_id"]))
            if tp and tp.get("status") in _VIVOS:
                vivos_por_mesa.setdefault(str(a["table_id"]), []).append(str(tp["id"]))
                mesa_do_vivo[str(tp["id"])] = str(a["table_id"])
        caidos_por_mesa: Dict[Optional[str], List[dict]] = {}
        for r in resultados:
            chave = str(r["table_id"]) if r.get("table_id") else None
            caidos_por_mesa.setdefault(chave, []).append(r)

        def jogador(tp_id: str, info: Optional[dict], mesa_id: Optional[str]) -> dict:
            tp = tp_por_id[tp_id]
            pid = str(tp["player_id"])
            linha = por_tp.get(tp_id) or {}
            congelado = foto.get(tp_id) if oficial else None
            if congelado:
                info = {"posicao": congelado.get("position"), "pontos": Decimal(str(congelado["points"])),
                        "empate": (info or {}).get("empate", False), "ordem": (info or {}).get("ordem")}
            equipe = equipe_do_jogador.get(pid)
            return {
                "tp_id": tp_id,
                "player_id": pid,
                "name": (nomes.get(pid) or {}).get("name"),
                "nickname": (nomes.get(pid) or {}).get("nickname"),
                "team_id": equipe,
                "team_name": nome_da_equipe.get(equipe) if equipe else None,
                "is_captain": pid in capitaes,
                "status": tp.get("status"),
                "eliminated_at": linha.get("eliminated_at"),
                "tie_with_previous": bool(linha.get("tie_with_previous")),
                "manual_position": linha.get("manual_position"),
                "source": linha.get("source") or "auto",
                "order": (info or {}).get("ordem"),
                "position": (info or {}).get("posicao"),
                "points": (info or {}).get("pontos"),
                "tie": bool((info or {}).get("empate")),
                "table_id": mesa_id,
            }

        mesas_saida = []
        pontos: Dict[str, Decimal] = {}
        mesa_e_posicao: Dict[str, dict] = {}
        ids_de_mesa = set(vivos_por_mesa) | {k for k in caidos_por_mesa if k}
        for mid in sorted(ids_de_mesa, key=lambda m: (numero_da_mesa.get(m) is None, numero_da_mesa.get(m) or 0, m)):
            linhas = caidos_por_mesa.get(mid, [])
            manuais = {str(r["tournament_player_id"]): int(r["manual_position"])
                       for r in linhas if r.get("manual_position")}
            vivos = vivos_por_mesa.get(mid, [])
            if manuais:
                try:
                    calc = R.resultado_manual(manuais)
                except ErroDeNegocio:
                    manuais = {}
            if manuais:
                pendentes = [v for v in vivos if v not in manuais]
                tamanho = calc["tamanho"]
                terminada = not pendentes
            else:
                ordenados = sorted(
                    (r for r in linhas if r.get("eliminated_at")),
                    key=lambda r: (_quando(r["eliminated_at"]), str(r["id"])),
                )
                calc = R.resultado_da_mesa(
                    [{"id": str(r["tournament_player_id"]), "tie_with_previous": r.get("tie_with_previous")}
                     for r in ordenados],
                    vivos,
                )
                pendentes = [v for v in vivos if v not in calc["jogadores"]]
                tamanho, terminada = calc["tamanho"], calc["terminada"]
            jogadores = [jogador(tp_id, info, mid) for tp_id, info in calc["jogadores"].items() if tp_id in tp_por_id]
            jogadores += [jogador(v, None, mid) for v in pendentes]
            for j in jogadores:
                if j["points"] is not None:
                    pontos[j["player_id"]] = j["points"]
                mesa_e_posicao[j["player_id"]] = {
                    "table_number": numero_da_mesa.get(mid), "position": j["position"], "points": j["points"],
                }
            jogadores.sort(key=lambda j: (j["position"] is not None, j["position"] or 0))
            mesas_saida.append({
                "table_id": mid,
                "table_number": numero_da_mesa.get(mid),
                "size": tamanho,
                "finished": terminada,
                "manual": bool(manuais),
                "players": [{**j, "points": _num(j["points"])} for j in jogadores],
            })

        sem_mesa = [jogador(str(r["tournament_player_id"]), None, None) for r in caidos_por_mesa.get(None, [])]
        if oficial:
            # Oficializada, vale a FOTO — mesmo que depois alguém desfaça uma
            # eliminação ou desmonte as mesas do dia.
            pontos = {}
            for r in foto.values():
                pid = str(r["player_id"])
                pontos[pid] = Decimal(str(r["points"]))
                mesa_e_posicao[pid] = {
                    "table_number": r.get("table_number"), "position": r.get("position"),
                    "points": Decimal(str(r["points"])),
                }

        entrada = [{
            "id": str(e["id"]),
            "captain_player_id": str(e.get("captain_player_id")),
            "members": [str(m["player_id"]) for m in d["membros"] if str(m["team_id"]) == str(e["id"])],
            "tiebreak_rank": e.get("tiebreak_rank"),
        } for e in d["equipes"]]
        criterio = torneio.get("team_tiebreak") or "best_individual"
        classificacao = R.ranking(entrada, pontos, criterio)
        por_equipe = {str(e["id"]): e for e in d["equipes"]}
        ranking = []
        for linha in classificacao:
            equipe = por_equipe[linha["team_id"]]
            if oficial and equipe.get("stage1_rank") is not None:
                linha["rank"] = equipe["stage1_rank"]
            membros = sorted(
                (m for m in d["membros"] if str(m["team_id"]) == linha["team_id"]),
                key=lambda m: m.get("relay_order") or 0,
            )
            ranking.append({
                "team_id": linha["team_id"],
                "name": equipe.get("name"),
                "points": float(linha["pontos"]),
                "captain_points": float(linha["pontos_capitao"]),
                "rank": linha["rank"],
                "tied": linha["empatada"],
                "verified": bool(equipe.get("captain_verified_at")),
                "verified_at": equipe.get("captain_verified_at"),
                "tiebreak_rank": equipe.get("tiebreak_rank"),
                "final_tp_id": equipe.get("final_tp_id"),
                "members": [{
                    "player_id": str(m["player_id"]),
                    "name": (nomes.get(str(m["player_id"])) or {}).get("name"),
                    "is_captain": str(m["player_id"]) == str(equipe.get("captain_player_id")),
                    "status": (tp_por_jogador.get(str(m["player_id"])) or {}).get("status"),
                    "table_number": (mesa_e_posicao.get(str(m["player_id"])) or {}).get("table_number"),
                    "position": (mesa_e_posicao.get(str(m["player_id"])) or {}).get("position"),
                    "points": _num((mesa_e_posicao.get(str(m["player_id"])) or {}).get("points")),
                } for m in membros],
            })
        if oficial:
            ranking.sort(key=lambda l: (l["rank"] is None, l["rank"] or 0))

        finalistas = torneio.get("team_finalists")
        avisos = []
        avulsos = [t for t in tp_por_id.values() if str(t["player_id"]) not in equipe_do_jogador]
        if avulsos:
            avisos.append({"code": "jogadores_sem_equipe", "count": len(avulsos)})
        if sem_mesa:
            avisos.append({"code": "eliminados_sem_mesa", "count": len(sem_mesa)})
        vivos_sem_assento = [t for t in tp_por_id.values() if t.get("status") in _VIVOS and str(t["id"]) not in mesa_do_vivo]
        if vivos_sem_assento:
            avisos.append({"code": "vivos_sem_assento", "count": len(vivos_sem_assento)})
        incompletas = []
        for e in d["equipes"]:
            delas = [m for m in d["membros"] if str(m["team_id"]) == str(e["id"])]
            inscritos = [m for m in delas if str(m["player_id"]) in tp_por_jogador]
            if len(delas) < R.JOGADORES_POR_EQUIPE or len(inscritos) < len(delas):
                incompletas.append(e.get("name"))
        if incompletas:
            avisos.append({"code": "equipes_incompletas", "teams": ", ".join(incompletas), "count": len(incompletas)})
        repetidas = []
        for e in d["equipes"]:
            mesas_dela = [
                (mesa_e_posicao.get(str(m["player_id"])) or {}).get("table_number")
                for m in d["membros"] if str(m["team_id"]) == str(e["id"])
            ]
            mesas_dela = [m for m in mesas_dela if m is not None]
            if len(mesas_dela) != len(set(mesas_dela)):
                repetidas.append(e.get("name"))
        if repetidas:
            avisos.append({"code": "colegas_na_mesma_mesa", "teams": ", ".join(repetidas), "count": len(repetidas)})

        em_jogo = [m["table_number"] for m in mesas_saida if not m["finished"]]
        return {
            "tournament_id": str(torneio["id"]),
            "day_id": (fase1 or {}).get("id"),
            "final_day_id": (final or {}).get("id"),
            "official": oficial,
            "official_at": torneio.get("team_results_official_at"),
            "finalists": finalistas,
            "tiebreak": criterio,
            "tables": mesas_saida,
            "unseated": [{**j, "points": _num(j["points"])} for j in sem_mesa],
            "ranking": ranking,
            "cut_tie": R.empate_na_linha_de_corte(classificacao, finalistas),
            "tables_in_play": em_jogo,
            "final_set_up": any(e.get("final_tp_id") for e in d["equipes"]),
            "warnings": avisos,
        }

    @staticmethod
    def fase1_resumo(tournament_id: str) -> dict:
        return TeamService._montar_fase1(TeamService._dados_da_fase1(tournament_id))

    # ── Fase 1: correções da direção ────────────────────────────────────────
    @staticmethod
    def corrigir_resultado(tournament_id: str, tp_id: str, tie_with_previous: Optional[bool] = None,
                           table_id: Optional[str] = None, swap_with_previous: bool = False,
                           user_id: Optional[str] = None) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        fase1, _ = TeamService.dias(tournament_id)
        if not fase1:
            raise ErroDeNegocio("resultado_nao_encontrado", "Eliminação não encontrada.", status=404)
        rid = id_do_resultado(fase1["id"], tp_id)
        linhas = supabase.table("tournament_team_results").select("*").eq("id", rid).execute().data or []
        if not linhas:
            raise ErroDeNegocio("resultado_nao_encontrado", "Eliminação não encontrada.", status=404)
        linha = linhas[0]
        patch: Dict[str, object] = {}
        if tie_with_previous is not None:
            patch["tie_with_previous"] = bool(tie_with_previous)
        if table_id is not None:
            mesa = (
                supabase.table("tournament_tables").select("id")
                .eq("id", str(table_id)).eq("tournament_day_id", str(fase1["id"])).execute().data or []
            )
            if not mesa:
                raise ErroDeNegocio("mesa_nao_encontrada", "Mesa não encontrada neste dia.", status=404)
            patch["table_id"] = str(table_id)
        if swap_with_previous:
            TeamService._trocar_com_anterior(fase1["id"], linha)
        if patch:
            patch.update({"updated_by": user_id, "updated_at": _agora()})
            supabase.table("tournament_team_results").update(patch).eq("id", rid).execute()
        return TeamService.fase1_resumo(tournament_id)

    @staticmethod
    def _trocar_com_anterior(day_id: str, linha: dict) -> None:
        """Inverte a ordem de duas eliminações da mesma mesa (cliques fora de
        ordem, aparelhos offline): troca as horas entre as duas."""
        if not linha.get("table_id") or not linha.get("eliminated_at"):
            raise ErroDeNegocio("sem_eliminacao_anterior", "Não há eliminação anterior nesta mesa.")
        da_mesa = (
            supabase.table("tournament_team_results").select("*")
            .eq("tournament_day_id", str(day_id)).eq("table_id", str(linha["table_id"])).execute().data or []
        )
        tps = {
            str(t["id"]): t for t in (
                supabase.table("tournament_players").select("id, status")
                .in_("id", [str(r["tournament_player_id"]) for r in da_mesa]).execute().data or []
            )
        }
        valem = sorted(
            (r for r in da_mesa
             if r.get("eliminated_at") and (tps.get(str(r["tournament_player_id"])) or {}).get("status") == "eliminated"),
            key=lambda r: (_quando(r["eliminated_at"]), str(r["id"])),
        )
        posicao = next((i for i, r in enumerate(valem) if str(r["id"]) == str(linha["id"])), None)
        if not posicao:
            raise ErroDeNegocio("sem_eliminacao_anterior", "Não há eliminação anterior nesta mesa.")
        anterior = valem[posicao - 1]
        hora_dela, hora_anterior = _quando(linha["eliminated_at"]), _quando(anterior["eliminated_at"])
        if hora_dela == hora_anterior:
            # Mesma hora: quem decide é o id. Basta pôr esta 1 ms antes.
            supabase.table("tournament_team_results").update({
                "eliminated_at": (hora_anterior - timedelta(milliseconds=1)).isoformat(), "updated_at": _agora(),
            }).eq("id", linha["id"]).execute()
            return
        supabase.table("tournament_team_results").update(
            {"eliminated_at": hora_anterior.isoformat(), "updated_at": _agora()}
        ).eq("id", linha["id"]).execute()
        supabase.table("tournament_team_results").update(
            {"eliminated_at": hora_dela.isoformat(), "updated_at": _agora()}
        ).eq("id", anterior["id"]).execute()

    @staticmethod
    def posicoes_da_mesa(tournament_id: str, table_id: str, posicoes: Dict[str, int],
                         user_id: Optional[str] = None) -> dict:
        """A direção digita as posições de uma mesa TERMINADA (o papel da mesa
        manda). Posições iguais = empate (dividem a média)."""
        dados = TeamService._dados_da_fase1(tournament_id)
        TeamService._recusar_se_oficializado(dados["torneio"])
        resumo = TeamService._montar_fase1(dados)
        mesa = next((m for m in resumo["tables"] if str(m["table_id"]) == str(table_id)), None)
        if not mesa:
            raise ErroDeNegocio("mesa_nao_encontrada", "Mesa não encontrada neste dia.", status=404)
        vivos = [p for p in mesa["players"] if p["status"] in _VIVOS]
        if len(vivos) > 1:
            raise ErroDeNegocio(
                "mesa_em_jogo", f"A mesa {mesa['table_number']} ainda está em jogo.",
                status=409, mesa=mesa["table_number"],
            )
        participantes = {p["tp_id"] for p in mesa["players"]}
        digitadas = {str(k): int(v) for k, v in (posicoes or {}).items()}
        if set(digitadas) != participantes:
            raise ErroDeNegocio("posicoes_incompletas", "Informe a posição de todos os jogadores desta mesa.")
        R.resultado_manual(digitadas)  # valida 1..N
        torneio, day_id = dados["torneio"], dados["fase1"]["id"]
        linhas = [{
            "id": id_do_resultado(day_id, p["tp_id"]),
            **_org(torneio),
            "tournament_id": str(tournament_id),
            "tournament_day_id": str(day_id),
            "tournament_player_id": p["tp_id"],
            "player_id": p["player_id"],
            "table_id": str(table_id),
            "eliminated_at": p.get("eliminated_at"),
            "tie_with_previous": bool(p.get("tie_with_previous")),
            "manual_position": digitadas[p["tp_id"]],
            "source": "manual",
            "updated_by": user_id,
            "updated_at": _agora(),
        } for p in mesa["players"]]
        supabase.table("tournament_team_results").upsert(linhas).execute()
        return TeamService.fase1_resumo(tournament_id)

    @staticmethod
    def limpar_posicoes_da_mesa(tournament_id: str, table_id: str) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        fase1, _ = TeamService.dias(tournament_id)
        if fase1:
            linhas = (
                supabase.table("tournament_team_results").select("id, eliminated_at")
                .eq("tournament_day_id", str(fase1["id"])).eq("table_id", str(table_id)).execute().data or []
            )
            # O vencedor só tem linha por causa das posições digitadas.
            sem_eliminacao = [l["id"] for l in linhas if not l.get("eliminated_at")]
            com_eliminacao = [l["id"] for l in linhas if l.get("eliminated_at")]
            if sem_eliminacao:
                supabase.table("tournament_team_results").delete().in_("id", sem_eliminacao).execute()
            if com_eliminacao:
                supabase.table("tournament_team_results").update(
                    {"manual_position": None, "source": "auto", "updated_at": _agora()}
                ).in_("id", com_eliminacao).execute()
        return TeamService.fase1_resumo(tournament_id)

    # ── Fase 1: conferência, desempate e oficialização ─────────────────────
    @staticmethod
    def conferir(tournament_id: str, team_id: str, conferido: bool, user_id: Optional[str] = None) -> dict:
        TeamService.torneio(tournament_id)
        TeamService._equipe(tournament_id, team_id)
        supabase.table("tournament_teams").update({
            "captain_verified_at": _agora() if conferido else None,
            "captain_verified_by": user_id if conferido else None,
            "updated_at": _agora(),
        }).eq("id", str(team_id)).execute()
        return TeamService.fase1_resumo(tournament_id)

    @staticmethod
    def desempate_manual(tournament_id: str, team_ids: List[str]) -> dict:
        torneio = TeamService.torneio(tournament_id)
        TeamService._recusar_se_oficializado(torneio)
        for i, team_id in enumerate(team_ids):
            supabase.table("tournament_teams").update({"tiebreak_rank": i + 1, "updated_at": _agora()}) \
                .eq("id", str(team_id)).eq("tournament_id", str(tournament_id)).execute()
        return TeamService.fase1_resumo(tournament_id)

    @staticmethod
    def oficializar(tournament_id: str, user_id: Optional[str] = None, force: bool = False) -> dict:
        dados = TeamService._dados_da_fase1(tournament_id)
        torneio = dados["torneio"]
        if torneio.get("team_results_official_at"):
            raise ErroDeNegocio("fase1_oficializada", "A Fase 1 já foi oficializada.", status=409)
        resumo = TeamService._montar_fase1(dados)
        if resumo["tables_in_play"] and not force:
            mesas = ", ".join(str(m) for m in resumo["tables_in_play"])
            raise ErroDeNegocio(
                "mesas_em_jogo_na_fase1", f"Ainda há mesas em jogo: {mesas}.", status=409, mesas=mesas,
            )
        if resumo["cut_tie"]:
            raise ErroDeNegocio(
                "empate_na_linha_de_corte",
                "Há equipes empatadas na linha de corte da final: resolva o desempate antes de oficializar.",
                status=409,
            )
        day_id = dados["fase1"]["id"]
        foto = []
        for mesa in resumo["tables"]:
            for p in mesa["players"]:
                if p["points"] is None:
                    continue
                foto.append({
                    "id": id_do_resultado(day_id, p["tp_id"]),
                    **_org(torneio),
                    "tournament_id": str(tournament_id),
                    "tournament_day_id": str(day_id),
                    "tournament_player_id": p["tp_id"],
                    "player_id": p["player_id"],
                    "table_id": mesa["table_id"],
                    "table_number": mesa["table_number"],
                    "eliminated_at": p.get("eliminated_at"),
                    "tie_with_previous": bool(p.get("tie_with_previous")),
                    "manual_position": p.get("manual_position"),
                    "position": p["position"],
                    "points": p["points"],
                    "table_size": mesa["size"],
                    "source": p.get("source") or "auto",
                    "updated_by": user_id,
                    "updated_at": _agora(),
                })
        if foto:
            supabase.table("tournament_team_results").upsert(foto).execute()
        por_equipe = {l["team_id"]: l for l in resumo["ranking"]}
        equipes = [{
            **e,
            "stage1_points": por_equipe[str(e["id"])]["points"],
            "stage1_rank": por_equipe[str(e["id"])]["rank"],
            "updated_at": _agora(),
        } for e in dados["equipes"] if str(e["id"]) in por_equipe]
        if equipes:
            supabase.table("tournament_teams").upsert(equipes).execute()
        supabase.table("tournaments").update({
            "team_results_official_at": _agora(),
            "team_results_official_by": user_id,
        }).eq("id", str(tournament_id)).execute()
        return TeamService.fase1_resumo(tournament_id)

    @staticmethod
    def desoficializar(tournament_id: str) -> dict:
        torneio = TeamService.torneio(tournament_id)
        if not torneio.get("team_results_official_at"):
            return TeamService.fase1_resumo(tournament_id)
        equipes, _ = TeamService._carregar(tournament_id)
        if any(e.get("final_tp_id") for e in equipes):
            raise ErroDeNegocio(
                "final_ja_montada", "A final já foi montada: desfaça a final antes.", status=409,
            )
        # Linhas que só existiam pela foto (vencedores, sem eliminação).
        supabase.table("tournament_team_results").delete() \
            .eq("tournament_id", str(tournament_id)).is_("eliminated_at", "null").eq("source", "auto").execute()
        supabase.table("tournament_team_results").update(
            {"position": None, "points": None, "table_size": None}
        ).eq("tournament_id", str(tournament_id)).execute()
        supabase.table("tournament_teams").update(
            {"stage1_points": None, "stage1_rank": None}
        ).eq("tournament_id", str(tournament_id)).execute()
        supabase.table("tournaments").update(
            {"team_results_official_at": None, "team_results_official_by": None}
        ).eq("id", str(tournament_id)).execute()
        return TeamService.fase1_resumo(tournament_id)

    # ── Final por revezamento ───────────────────────────────────────────────
    @staticmethod
    def montar_final(tournament_id: str, finalistas: int, fichas: Optional[int] = None) -> dict:
        """Uma inscrição por equipe classificada no dia final (a do capitão),
        com o stack novo e igual para todas. Os pontos da Fase 1 não passam."""
        from app.services.tournament_day_service import TournamentDayService, _chipcount_cache

        torneio = TeamService.torneio(tournament_id)
        if not torneio.get("team_results_official_at"):
            raise ErroDeNegocio(
                "fase1_nao_oficializada", "Oficialize a Fase 1 antes de montar a final.", status=409,
            )
        fase1, final = TeamService.dias(tournament_id)
        if not final:
            raise ErroDeNegocio("torneio_sem_dia_final", "Este torneio não tem dia final.")
        equipes, _ = TeamService._carregar(tournament_id)
        if any(e.get("final_tp_id") for e in equipes):
            raise ErroDeNegocio("final_ja_montada", "A final já foi montada.", status=409)
        maximo = min(R.MAX_FINALISTAS, len(equipes))
        if finalistas < 1 or finalistas > maximo:
            raise ErroDeNegocio(
                "finalistas_invalido", f"Escolha de 1 a {maximo} equipes para a final.", maximo=maximo,
            )
        fichas = int(fichas or final.get("starting_chips") or 0)
        if fichas <= 0:
            raise ErroDeNegocio("fichas_da_final_obrigatorias", "Informe o stack de cada equipe na final.")
        ordenadas = sorted(
            (e for e in equipes if e.get("stage1_rank") is not None),
            key=lambda e: (e["stage1_rank"], str(e["id"])),
        )
        if len(ordenadas) > finalistas and ordenadas[finalistas - 1]["stage1_rank"] == ordenadas[finalistas]["stage1_rank"]:
            raise ErroDeNegocio(
                "empate_na_linha_de_corte",
                "Há equipes empatadas na linha de corte da final: resolva o desempate antes.",
                status=409,
            )
        classificadas = ordenadas[:finalistas]
        capitaes = [str(e["captain_player_id"]) for e in classificadas]
        ja_no_dia = [
            t for t in (
                supabase.table("tournament_players").select("id, player_id, status")
                .eq("tournament_day_id", str(final["id"])).in_("player_id", capitaes).execute().data or []
            ) if t.get("status") != "cancelled"
        ]
        if ja_no_dia:
            raise ErroDeNegocio(
                "capitao_ja_no_dia_final", "Um dos capitães já está inscrito no dia final.", status=409,
            )

        # Pozo e entradas do dia final herdam os da Fase 1, como no avanço de
        # classificados — lidos ANTES do insert (o trigger do prêmio recalcula
        # o dia final a cada linha nova).
        dia_fase1 = TournamentDayService.get_tournament_day(fase1["id"]) if fase1 else None
        dia_final = TournamentDayService.get_tournament_day(final["id"])
        entradas_fase1 = TournamentDayService._entradas_do_dia(dia_fase1)[1] if dia_fase1 else 0

        inseridas = supabase.table("tournament_players").insert([{
            **_org(torneio),
            "tournament_id": str(tournament_id),
            "tournament_day_id": str(final["id"]),
            "player_id": str(e["captain_player_id"]),
            "buy_in_count": 0,
            "total_buy_in_amount": 0,
            "rebuy_count": 0,
            "addon_count": 0,
            "total_chips": fichas,
            "status": "active",
            "is_qualified_entry": True,
            "qualified_from_day_id": (fase1 or {}).get("id"),
        } for e in classificadas]).execute().data or []
        por_capitao = {str(i["player_id"]): str(i["id"]) for i in inseridas}
        supabase.table("tournament_teams").upsert([{
            **e, "final_tp_id": por_capitao.get(str(e["captain_player_id"])), "updated_at": _agora(),
        } for e in classificadas]).execute()
        supabase.table("tournaments").update({"team_finalists": finalistas}).eq("id", str(tournament_id)).execute()
        if dia_final is not None:
            supabase.table("tournament_days").update({
                "total_entries": (dia_final.total_entries or 0) + entradas_fase1,
                "prize_pool": (dia_final.prize_pool or 0) + ((dia_fase1.prize_pool or 0) if dia_fase1 else 0),
            }).eq("id", str(final["id"])).execute()
        _chipcount_cache.pop(str(final["id"]), None)
        return TeamService.revezamento(tournament_id)

    @staticmethod
    def desfazer_final(tournament_id: str) -> dict:
        from app.services.allocation_service import liberar_assento_do_dia
        from app.services.tournament_day_service import TournamentDayService, _chipcount_cache

        torneio = TeamService.torneio(tournament_id)
        fase1, final = TeamService.dias(tournament_id)
        equipes, _ = TeamService._carregar(tournament_id)
        na_final = [e for e in equipes if e.get("final_tp_id")]
        if not na_final or not final:
            return TeamService.revezamento(tournament_id)
        if final.get("timer_started_at"):
            raise ErroDeNegocio("final_ja_comecou", "A final já começou: não dá para desfazer.", status=409)
        ids = [str(e["final_tp_id"]) for e in na_final]
        linhas = supabase.table("tournament_players").select("id, player_id, status").in_("id", ids).execute().data or []
        if any(l.get("status") == "eliminated" for l in linhas):
            raise ErroDeNegocio("final_ja_comecou", "A final já começou: não dá para desfazer.", status=409)
        dia_fase1 = TournamentDayService.get_tournament_day(fase1["id"]) if fase1 else None
        entradas_fase1 = TournamentDayService._entradas_do_dia(dia_fase1)[1] if dia_fase1 else 0
        for l in linhas:
            liberar_assento_do_dia(str(tournament_id), str(l["player_id"]), str(final["id"]), supabase)
        if ids:
            supabase.table("tournament_players").delete().in_("id", ids).execute()
        supabase.table("tournament_teams").update({"final_tp_id": None, "updated_at": _agora()}) \
            .eq("tournament_id", str(tournament_id)).execute()
        dia_final = TournamentDayService.get_tournament_day(final["id"])
        if dia_final is not None:
            supabase.table("tournament_days").update({
                "total_entries": max(0, (dia_final.total_entries or 0) - entradas_fase1),
            }).eq("id", str(final["id"])).execute()
        _chipcount_cache.pop(str(final["id"]), None)
        return TeamService.revezamento(tournament_id)

    @staticmethod
    def revezamento(tournament_id: str) -> dict:
        """Equipes da final com a ordem do revezamento e quem já caiu."""
        torneio = TeamService.torneio(tournament_id)
        _, final = TeamService.dias(tournament_id)
        equipes, membros = TeamService._carregar(tournament_id)
        na_final = [e for e in equipes if e.get("final_tp_id")]
        linhas = {}
        if na_final:
            linhas = {
                str(l["id"]): l for l in (
                    supabase.table("tournament_players").select("id, status, eliminated_at, total_chips")
                    .in_("id", [str(e["final_tp_id"]) for e in na_final]).execute().data or []
                )
            }
        nomes = TeamService._nomes(m["player_id"] for m in membros)
        saida = []
        for e in sorted(na_final, key=lambda e: (e.get("stage1_rank") or 0, str(e["id"]))):
            linha = linhas.get(str(e["final_tp_id"])) or {}
            delas = sorted((m for m in membros if str(m["team_id"]) == str(e["id"])), key=lambda m: m.get("relay_order") or 0)
            saida.append({
                "team_id": str(e["id"]),
                "name": e.get("name"),
                "final_tp_id": str(e["final_tp_id"]),
                "stage1_rank": e.get("stage1_rank"),
                "status": linha.get("status"),
                "eliminated_at": linha.get("eliminated_at"),
                "members": [{
                    "player_id": str(m["player_id"]),
                    "name": (nomes.get(str(m["player_id"])) or {}).get("name"),
                    "nickname": (nomes.get(str(m["player_id"])) or {}).get("nickname"),
                    "relay_order": m.get("relay_order"),
                    "is_captain": str(m["player_id"]) == str(e.get("captain_player_id")),
                } for m in delas],
            })
        return {
            "tournament_id": str(torneio["id"]),
            "final_day_id": (final or {}).get("id"),
            "final_started": bool((final or {}).get("timer_started_at")),
            "start_level": 1,
            "official": bool(torneio.get("team_results_official_at")),
            "teams": saida,
            "standings": TeamService._classificacao_final(saida, equipes),
        }

    @staticmethod
    def _classificacao_final(na_final: List[dict], equipes: List[dict]) -> List[dict]:
        """Finalistas: vivos primeiro, depois quem caiu por último; o resto
        pela posição da Fase 1."""
        vivas = [t for t in na_final if t.get("status") != "eliminated"]
        caidas = sorted(
            (t for t in na_final if t.get("status") == "eliminated"),
            key=lambda t: _quando(t.get("eliminated_at")), reverse=True,
        )
        ordem = []
        campea = len(vivas) == 1 and len(na_final) > 1
        for t in vivas:
            ordem.append({"team_id": t["team_id"], "name": t["name"], "status": "champion" if campea else "playing"})
        for t in caidas:
            ordem.append({"team_id": t["team_id"], "name": t["name"], "status": "eliminated"})
        na_final_ids = {t["team_id"] for t in na_final}
        for e in sorted((e for e in equipes if str(e["id"]) not in na_final_ids and e.get("stage1_rank") is not None),
                        key=lambda e: e["stage1_rank"]):
            ordem.append({"team_id": str(e["id"]), "name": e.get("name"), "status": "stage1"})
        posicao = 0
        for i, linha in enumerate(ordem):
            if linha["status"] == "playing" and len(vivas) > 1:
                linha["position"] = None
                continue
            posicao = i + 1
            linha["position"] = posicao
        return ordem
