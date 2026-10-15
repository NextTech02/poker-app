"""Roteiro ponta a ponta do torneio por equipes, pela camada de serviço contra o
banco REAL, como um usuário de verdade (RLS), na org Teste. Limpa tudo no fim.

Cadastro de 4 equipes + 2 avulsos → cobrança de uma equipe (meio "por
equipe") → sorteio das mesas (colegas separados) → eliminações mesa a mesa
(com um empate e uma eliminação desfeita) → pontos e ranking → oficializar →
final com 2 equipes → revezamento no telão → campeã.

Roda de dentro de backend/: venv\\Scripts\\python.exe scripts\\e2e_equipes_roteiro.py
"""
import os
import sys
import secrets
import traceback
from collections import Counter

sys.path.insert(0, os.getcwd())

from app.config import get_settings  # noqa: E402
from app.database.supabase_client import supabase_admin, set_request_jwt  # noqa: E402
from app.models.table import TableCreate  # noqa: E402
from app.models.tournament import TournamentCreate  # noqa: E402
from app.models.tournament_day import TournamentDayCreate  # noqa: E402
from app.models.tournament_player import TournamentPlayerCreate  # noqa: E402
from app.services.buy_type_service import BuyTypeService  # noqa: E402
from app.services.cashbox_service import CashboxService as CS  # noqa: E402
from app.services.public_tv_service import PublicTvService  # noqa: E402
from app.services.table_service import TableService  # noqa: E402
from app.services.team_charge_service import TeamChargeService  # noqa: E402
from app.services.team_service import TeamService as T  # noqa: E402
from app.services.tournament_day_service import TournamentDayService  # noqa: E402
from app.services.tournament_player_service import TournamentPlayerService as TPS  # noqa: E402
from app.services.tournament_service import TournamentService  # noqa: E402
from app.services.transaction_service import TransactionService  # noqa: E402
from app.utils.erros import ErroDeNegocio  # noqa: E402

ORG = "baa825a5-422a-4424-818a-028db0bbfc1c"      # org Teste
STAGE = "0ee063ba-cd91-4ef5-b4a8-2f9a3d37f04b"    # Etapa Goiânia · Out/26
EMAIL = "e2e-equipes@teste.local"
SENHA = "E2e!" + secrets.token_urlsafe(12)

criados = {"auth_user": None, "staff": None, "players": [], "tournament": None, "cashbox": None, "vendas": [],
           "override": "nao_mexi"}
AUTH = None


def ok(nome, cond, detalhe=""):
    print(("OK   " if cond else "FALHA"), nome, detalhe)
    if not cond:
        raise AssertionError(f"{nome} {detalhe}")


def recusa(fn, code):
    try:
        fn()
    except ErroDeNegocio as e:
        ok(f"recusa {code}", e.code == code, f"(veio {e.code}: {e.message})")
        return e
    raise AssertionError(f"esperava recusa {code}, passou")


def limpar():
    print("\n-- limpeza --")
    adm = supabase_admin
    for tx in criados["vendas"]:
        try:
            TransactionService.cancel_transaction(tx, AUTH, "E2E equipes: limpeza")
        except Exception as e:  # noqa: BLE001
            print("estorno falhou", tx, e)
    tid = criados["tournament"]
    if tid:
        adm.table("seat_allocations").delete().eq("tournament_id", tid).execute()
        adm.table("transactions").delete().eq("tournament_id", tid).execute()
        adm.table("tournament_players").delete().eq("tournament_id", tid).execute()
        adm.table("tournament_tables").delete().eq("tournament_id", tid).execute()
        adm.table("buy_types").delete().eq("tournament_id", tid).execute()
        adm.table("tournament_days").update({"qualifies_to_day_id": None}).eq("tournament_id", tid).execute()
        adm.table("tournament_days").delete().eq("tournament_id", tid).execute()
        adm.table("tournaments").delete().eq("id", tid).execute()
    cb = criados["cashbox"]
    if cb:
        adm.table("cashboxes").update({"current_session_id": None}).eq("id", cb).execute()
        adm.table("cashbox_transactions").delete().eq("cashbox_id", cb).execute()
        adm.table("cashbox_sessions").delete().eq("cashbox_id", cb).execute()
        adm.table("cashboxes").delete().eq("id", cb).execute()
    if criados["players"]:
        adm.table("players").delete().in_("id", criados["players"]).execute()
    if criados["auth_user"]:
        adm.table("activity_logs").delete().eq("auth_user_id", criados["auth_user"]).execute()
    if criados["staff"]:
        adm.table("staff").delete().eq("id", criados["staff"]).execute()
    if criados["override"] != "nao_mexi":
        # Devolve o limite de usuários do plano como estava.
        adm.table("organizations").update({"max_users_override": criados["override"]}).eq("id", ORG).execute()
    if criados["auth_user"]:
        try:
            adm.auth.admin.delete_user(criados["auth_user"])
        except Exception as e:  # noqa: BLE001
            print("usuario nao removido:", e)
    print("limpo")


try:
    settings = get_settings()
    novo = supabase_admin.auth.admin.create_user({
        "email": EMAIL, "password": SENHA, "email_confirm": True, "user_metadata": {"e2e": "equipes"},
    })
    AUTH = novo.user.id
    criados["auth_user"] = AUTH
    grupo = supabase_admin.table("permission_groups").select("id").eq("organization_id", ORG).eq("name", "Admin").execute().data
    ok("0 cargo Admin da org Teste", bool(grupo))
    # A org Teste é plano Free (2 usuários): um a mais só durante o roteiro.
    org = supabase_admin.table("organizations").select("max_users_override").eq("id", ORG).execute().data[0]
    criados["override"] = org.get("max_users_override")
    ativos = len(supabase_admin.table("staff").select("id").eq("organization_id", ORG).eq("active", True).execute().data)
    supabase_admin.table("organizations").update({"max_users_override": ativos + 1}).eq("id", ORG).execute()
    staff = supabase_admin.table("staff").insert({
        "auth_user_id": AUTH, "name": "E2E Diretor", "email": EMAIL, "active": True,
        "invite_status": "accepted", "permission_group_id": grupo[0]["id"], "organization_id": ORG,
    }).execute().data[0]
    criados["staff"] = staff["id"]
    import httpx
    link = supabase_admin.auth.admin.generate_link({"type": "magiclink", "email": EMAIL})
    r = httpx.post(f"{settings.supabase_url}/auth/v1/verify",
                   headers={"apikey": settings.supabase_anon_key, "Content-Type": "application/json"},
                   json={"type": "magiclink", "token_hash": link.properties.hashed_token}, timeout=30)
    ok("0 login (magic link)", r.status_code == 200, r.text[:120])
    set_request_jwt(r.json()["access_token"])

    # ── torneio, dias e meios de entrada ──
    recusa(lambda: TournamentService.create_tournament(
        TournamentCreate(name="E2E X", stage_id=STAGE, team_mode=True, elimination_mode="table"), AUTH),
        "equipes_exige_classificatorio")
    torneio = TournamentService.create_tournament(TournamentCreate(
        name="E2E Torneo por equipos", stage_id=STAGE, has_qualifying=True, elimination_mode="table",
        team_mode=True, team_finalists=2), AUTH)
    TID = torneio.id
    criados["tournament"] = TID
    ok("1 torneio por equipes criado", torneio.team_mode and torneio.team_finalists == 2)
    final = TournamentDayService.create_tournament_day(TournamentDayCreate(
        tournament_id=TID, day_name="E2E Final por relevos", day_number=2, day_type="final",
        buy_in=0, max_players=1000, starting_chips=30000, rake_percentage=0))
    fase1 = TournamentDayService.create_tournament_day(TournamentDayCreate(
        tournament_id=TID, day_name="E2E Fase 1", day_number=1, day_type="qualifying",
        qualifies_to_day_id=final.id, buy_in=100, max_players=100, starting_chips=20000,
        allocation_type="manual"))
    meios = BuyTypeService.substituir(TID, [
        {"name": "Individual", "category": "buy_in", "amount": 100, "rake_percentage": 10, "chips": 20000,
         "active": True, "sort_order": 0, "per_team": False},
        {"name": "Equipo", "category": "buy_in", "amount": 400.03, "rake_percentage": 10, "chips": 20000,
         "active": True, "sort_order": 1, "per_team": True},
    ])
    individual = next(m for m in meios if not m.get("per_team"))
    por_equipe = next(m for m in meios if m.get("per_team"))
    ok("1 meio 'por equipe' gravado", por_equipe["per_team"] is True)

    # ── jogadores e equipes ──
    for i in range(18):
        row = supabase_admin.table("players").insert({
            "name": f"E2E EQ Jogador {i:02d}", "nickname": f"J{i:02d}", "organization_id": ORG,
            "nationality": "BR", "document_type": "cpf", "document_number": f"E2EEQ{i:03d}",
            "email": f"e2eeq{i:03d}@e2e.eq", "phone": "000",
        }).execute().data[0]
        criados["players"].append(row["id"])
    P = criados["players"]
    equipes = []
    for k in range(4):
        membros = P[k * 4:(k + 1) * 4]
        dados = T.criar(TID, f"E2E Equipo {k + 1}", membros[0], membros)
        equipes.append(next(e for e in dados["teams"] if e["name"] == f"E2E Equipo {k + 1}"))
    ok("2 quatro equipes cadastradas", len(T.listar(TID)["teams"]) == 4)
    recusa(lambda: T.criar(TID, "E2E Intrusa", P[0], [P[0], P[16]]), "jogador_em_outra_equipe")
    avulsos = P[16:]

    # ── caixa e cobrança por equipe ──
    cb = CS.get_my_current(AUTH, stage_id=STAGE)
    criados["cashbox"] = cb.id
    CS.open_session(cb.id, AUTH, 0, None)
    cobranca = TeamChargeService.cobrar(TID, equipes[0]["id"], por_equipe["id"], "cash", "e2e-eq-cm1", AUTH)
    vendas = supabase_admin.table("transactions").select("id, amount, rake_amount, player_id, client_id") \
        .eq("tournament_id", TID).execute().data
    criados["vendas"] += [v["id"] for v in vendas]
    ok("3 equipe cobrada: 4 vendas somando 400,03",
       cobranca["charged"] == 4 and round(sum(float(v["amount"]) for v in vendas), 2) == 400.03,
       str(sorted(float(v["amount"]) for v in vendas)))
    capitao = next(v for v in vendas if v["player_id"] == P[0])
    ok("3 centavo que sobra fica com o capitão", float(capitao["amount"]) == 100.01)
    ok("3 reenvio do mesmo clique não cobra de novo",
       TeamChargeService.cobrar(TID, equipes[0]["id"], por_equipe["id"], "cash", "e2e-eq-cm1", AUTH)["charged"] == 0)
    recusa(lambda: TPS.register_player(TournamentPlayerCreate(
        tournament_id=TID, tournament_day_id=fase1.id, player_id=P[4], buy_type_id=por_equipe["id"]), AUTH),
        "meio_de_entrada_por_equipe")
    avulso = TPS.register_player(TournamentPlayerCreate(
        tournament_id=TID, tournament_day_id=fase1.id, player_id=avulsos[0], buy_type_id=individual["id"]), AUTH)
    criados["vendas"] += [v["id"] for v in supabase_admin.table("transactions").select("id")
                          .eq("tournament_player_id", avulso.id).execute().data]
    # O resto entra direto (sem dinheiro): o roteiro testa a Fase 1, não o Caixa.
    supabase_admin.table("tournament_players").insert([{
        "tournament_id": TID, "tournament_day_id": fase1.id, "player_id": p, "organization_id": ORG,
        "buy_in_count": 1, "total_buy_in_amount": 0, "total_chips": 20000, "status": "active",
    } for p in P[4:16] + avulsos[1:]]).execute()
    inscritos = supabase_admin.table("tournament_players").select("id, player_id, status") \
        .eq("tournament_day_id", fase1.id).execute().data
    ok("3 dezoito inscritos na Fase 1", len(inscritos) == 18)
    tp_de = {i["player_id"]: i["id"] for i in inscritos}

    # ── mesas e sorteio ──
    # Plano Free: até 4 mesas por torneio — e 4 é o mínimo do torneio por equipes.
    for n in range(1, 5):
        TableService.create_table(TID, TableCreate(table_number=n, seats=9), fase1.id)
    sorteio = T.sortear_mesas(TID)
    ok("4 sorteio sentou os 18", sorteio["allocated"] == 18)
    alocs = supabase_admin.table("seat_allocations").select("player_id, table_id, seat_number") \
        .eq("tournament_day_id", fase1.id).execute().data
    mesa_de = {a["player_id"]: a["table_id"] for a in alocs}
    for e in equipes:
        ok(f"4 {e['name']} em 4 mesas diferentes", len({mesa_de[m['player_id']] for m in e["members"]}) == 4)
    tamanhos = sorted(Counter(mesa_de.values()).values())
    ok("4 usa o mínimo de mesas (4) e equilibra", tamanhos == [4, 4, 5, 5], str(tamanhos))
    mesa_de_a1 = mesa_de[P[0]]
    recusa(lambda: T.recusar_mesa_com_colega(TID, P[1], mesa_de_a1), "mesa_com_companheiro")

    # ── eliminações mesa a mesa ──
    por_mesa = {}
    for p, m in mesa_de.items():
        por_mesa.setdefault(m, []).append(p)
    primeira_mesa = sorted(por_mesa)[0]
    for mesa, jogadores in sorted(por_mesa.items()):
        for p in jogadores[:-1]:
            TPS.eliminar(tp_de[p], AUTH)
    ok("5 resultado gravado com a mesa de cada eliminado",
       len(supabase_admin.table("tournament_team_results").select("id").eq("tournament_id", TID).execute().data) == 14)
    caido = por_mesa[primeira_mesa][0]
    recusa(lambda: TPS.add_rebuy(tp_de[caido], AUTH), "reentrada_nao_permitida_em_equipes")
    # Desfaz e refaz uma eliminação: a última é que vale.
    TPS.uneliminate_player(tp_de[caido])
    supabase_admin.table("seat_allocations").insert({
        "tournament_id": TID, "tournament_day_id": fase1.id, "player_id": caido,
        "table_id": primeira_mesa, "seat_number": 9, "organization_id": ORG,
    }).execute()
    TPS.eliminar(tp_de[caido], AUTH)
    # Depois de refazer, a ordem na mesa é [1], [2], …, [0]: o [2] empata com o [1].
    segundo = por_mesa[primeira_mesa][2]
    T.corrigir_resultado(TID, tp_de[segundo], tie_with_previous=True, user_id=AUTH)

    resumo = T.fase1_resumo(TID)
    ok("6 todas as mesas terminadas", not resumo["tables_in_play"], str(resumo["tables_in_play"]))
    for mesa in resumo["tables"]:
        n = mesa["size"]
        soma = round(sum(p["points"] for p in mesa["players"]), 2)
        ok(f"6 mesa {mesa['table_number']}: soma dos pontos = 5·N(N+1)/2", soma == 5 * n * (n + 1) / 2, f"{soma} (N={n})")
    m1 = next(m for m in resumo["tables"] if m["table_id"] == primeira_mesa)
    empatados = [p for p in m1["players"] if p["tie"]]
    ok("6 empate com o anterior divide os pontos", len(empatados) == 2 and empatados[0]["points"] == empatados[1]["points"],
       str([(p["name"], p["points"]) for p in empatados]))
    ok("6 ranking com 4 equipes", len(resumo["ranking"]) == 4)

    # ── oficializar, final e revezamento ──
    recusa(lambda: TournamentDayService.advance_qualifiers(fase1.id), "avancar_equipes_pela_tela_de_equipes")
    if resumo["cut_tie"]:
        empatadas = [l["team_id"] for l in resumo["ranking"] if l["rank"] == resumo["ranking"][1]["rank"]]
        supabase_admin.table("tournaments").update({"team_tiebreak": "manual"}).eq("id", TID).execute()
        T.desempate_manual(TID, empatadas)
    oficial = T.oficializar(TID, AUTH)
    ok("7 Fase 1 oficializada", oficial["official"])
    recusa(lambda: T.corrigir_resultado(TID, tp_de[segundo], tie_with_previous=False), "fase1_oficializada")
    relay = T.montar_final(TID, 2)
    linhas_final = supabase_admin.table("tournament_players").select("id, player_id, total_chips, is_qualified_entry") \
        .eq("tournament_day_id", final.id).execute().data
    ok("7 final: uma inscrição por equipe com 30.000", len(linhas_final) == 2
       and all(l["total_chips"] == 30000 and l["is_qualified_entry"] for l in linhas_final))
    primeira = relay["teams"][0]
    nova_ordem = [m["player_id"] for m in reversed(primeira["members"])]
    T.definir_ordem(TID, primeira["team_id"], nova_ordem)
    relay = T.revezamento(TID)
    ok("7 ordem do revezamento trocada", [m["player_id"] for m in relay["teams"][0]["members"]] == nova_ordem)
    extras = PublicTvService.get_day_extras(final.id)
    ok("7 telão do dia final traz o revezamento (apelidos)",
       extras.relay and len(extras.relay["teams"]) == 2 and extras.relay["teams"][0]["members"][0].startswith("J"),
       str(extras.relay))
    ok("7 telão da Fase 1 sem revezamento", PublicTvService.get_day_extras(fase1.id).relay is None)
    TPS.eliminar(relay["teams"][1]["final_tp_id"], AUTH)
    standings = T.revezamento(TID)["standings"]
    ok("8 campeã definida", standings[0]["status"] == "champion" and standings[0]["position"] == 1, str(standings[:2]))
    print("\nROTEIRO COMPLETO")
except Exception:  # noqa: BLE001
    traceback.print_exc()
finally:
    try:
        limpar()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
