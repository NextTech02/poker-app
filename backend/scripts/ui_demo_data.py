# -*- coding: utf-8 -*-
"""Dados de demonstração na org Teste (sandbox), pela API local, como o admin de
preview (ver ui_preview_session.py).
Torneio (etapa, dia, meios de entrada, vendas), cash (modalidades, dia, mesas,
jogadores sentados) e bar (produtos, turno, comandas). Idempotente-ish: se já
houver etapa "Etapa Brasília · Set/26", só reaproveita o que existir.
"""
import io, json, os, re, sys, uuid, datetime as dt
import httpx
HERE = os.path.dirname(os.path.abspath(__file__))
url = io.open(os.path.join(HERE, ".ui_preview_url.txt"), encoding="utf-8").read()
TOKEN = re.search(r"access_token=([^&]+)", url).group(1)
API = "http://127.0.0.1:8000"
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
c = httpx.Client(base_url=API, headers=H, timeout=60)
HOJE = dt.date.today().isoformat()

def call(method, path, body=None, headers=None, ok=(200, 201)):
    r = c.request(method, path, json=body, headers=headers)
    if r.status_code not in ok:
        print(f"  !! {method} {path} -> {r.status_code}: {r.text[:300]}")
        return None
    return r.json() if r.text else None

# ── jogadores ────────────────────────────────────────────────────────────────
NOMES = ["Ana Souza", "Bruno Lima", "Carlos Mendes", "Diego Rocha", "Eduarda Pires", "Felipe Alves", "Gabriel Nunes", "Helena Castro", "Igor Tavares", "Júlia Ramos"]
players = call("GET", "/players") or []
existentes = {p["name"]: p for p in players}
def cpf_valido(semente):
    base = [int(d) for d in f"{semente:09d}"]
    for k in (10, 11):
        soma = sum(d * w for d, w in zip(base, range(k, 1, -1)))
        dv = 11 - (soma % 11); base.append(0 if dv >= 10 else dv)
    d = ''.join(map(str, base))
    return f"{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}"

ids = []
for i, n in enumerate(NOMES):
    if n in existentes:
        ids.append(existentes[n]["id"]); continue
    first, last = n.split(" ", 1)
    p = call("POST", "/players", {"name": n, "first_name": first, "last_name": last, "email": f"{first.lower()}.{i}@demo.aceblind", "phone": f"+55 61 9{i:04d}-{1000+i}",
                                  "nationality": "Brasil", "document_type": "cpf", "document_number": cpf_valido(123456780 + i * 7919), "nickname": first.lower()})
    if p: ids.append(p["id"])
print("jogadores:", len(ids))

# ── etapa + torneio + dia ────────────────────────────────────────────────────
stages = call("GET", "/stages") or []
stage = next((s for s in stages if s["name"].startswith("Etapa Brasília")), None)
if not stage:
    stage = call("POST", "/stages", {"name": "Etapa Brasília · Set/26", "location": "Brasília, DF", "start_date": (dt.date.today() - dt.timedelta(days=3)).isoformat(),
                                     "end_date": (dt.date.today() + dt.timedelta(days=3)).isoformat(), "description": "Demonstração"})
HS = {"X-Stage-ID": stage["id"]}
print("etapa:", stage["id"])
# Outras etapas, só para a lista mostrar cada estado (próxima, concluídas,
# arquivada). Sem torneio nem venda: nada além do cadastro.
OUTRAS = [
    ("Etapa Goiânia · Out/26", "Goiânia, GO", 21, 24, "upcoming"),
    ("Etapa São Paulo · Ago/26", "São Paulo, SP", -28, -25, "completed"),
    ("Etapa Rio · Jul/26", "Rio de Janeiro, RJ", -68, -65, "completed"),
    ("Etapa Curitiba · Mai/26", "Curitiba, PR", -130, -128, "cancelled"),
]
nomes_existentes = {s["name"] for s in stages}
for nome, local, ini, fim, status in OUTRAS:
    if nome in nomes_existentes:
        continue
    call("POST", "/stages", {"name": nome, "location": local, "status": status,
                             "start_date": (dt.date.today() + dt.timedelta(days=ini)).isoformat(),
                             "end_date": (dt.date.today() + dt.timedelta(days=fim)).isoformat()})
print("etapas:", len(call("GET", "/stages") or []))
tours = call("GET", "/tournaments", headers=HS) or []
tour = next((t for t in tours if t["name"] == "Main Event 500"), None)
if not tour:
    tour = call("POST", "/tournaments", {"name": "Main Event 500", "stage_id": stage["id"]}, headers=HS)
days = call("GET", f"/tournament-days/tournament/{tour['id']}", headers=HS) or []
day = days[0] if days else call("POST", "/tournament-days", {
    "tournament_id": tour["id"], "day_name": "Dia 1B", "day_number": 1, "buy_in": 500, "rebuy_amount": 500, "addon_amount": 300,
    "rake_percentage": 20, "max_players": 120, "starting_chips": 30000, "rebuy_chips": 30000, "addon_chips": 40000,
    "blind_duration": 20, "initial_small_blind": 100, "initial_big_blind": 200}, headers=HS)
print("torneio/dia:", tour["id"], day["id"] if day else None)
bts = call("GET", f"/tournament-days/{day['id']}/buy-types", headers=HS) or []
if not bts:
    call("PUT", f"/tournament-days/{day['id']}/buy-types", {"items": [
        {"name": "Buy-in", "category": "buy_in", "amount": 500, "rake_percentage": 20, "chips": 30000},
        {"name": "Rebuy", "category": "rebuy", "amount": 500, "rake_percentage": 20, "chips": 30000},
        {"name": "Add-on", "category": "addon", "amount": 300, "rake_percentage": 10, "chips": 40000}]}, headers=HS)
    bts = call("GET", f"/tournament-days/{day['id']}/buy-types", headers=HS) or []
buyin = next((b for b in bts if b["category"] == "buy_in"), None)
# caixa do operador na etapa
cb = call("GET", "/cashboxes/me/current", headers=HS)
if cb and cb.get("status") != "open":
    call("POST", f"/cashboxes/{cb['id']}/open", {"initial_balance": 300}, headers=HS)
# vendas
regs = call("GET", f"/tournament-players/tournament/{tour['id']}", headers=HS) or []
ja = {r["player_id"] for r in regs}
metodos = ["pix", "cash", "card", "pix", "cash", "pix"]
for pid, met in zip(ids[:6], metodos):
    if pid in ja: continue
    call("POST", "/tournament-players", {"tournament_id": tour["id"], "tournament_day_id": day["id"], "player_id": pid, "buy_in_count": 1,
                                         "payment_source": "cash", "payment_method": met, "buy_type_id": buyin["id"] if buyin else None,
                                         "notes": "demo", "client_id": str(uuid.uuid4()), "client_mutation_id": str(uuid.uuid4())}, headers=HS)
print("inscritos:", len(call("GET", f"/tournament-players/tournament/{tour['id']}", headers=HS) or []))
if day and day.get("status") in (None, "pending"):
    call("POST", f"/tournament-days/{day['id']}/timer/start", {}, headers=HS)

# ── cash game ────────────────────────────────────────────────────────────────
gts = call("GET", "/cash-game/game-types") or []
if not gts:
    for g in [{"name": "NLH", "game_variant": "nlh", "small_blind": 5, "big_blind": 10, "min_buy_in": 500, "max_buy_in": 2000, "default_seats": 9, "rake_percent": 5, "rake_cap": 60, "jackpot_per_pot": 2},
              {"name": "PLO", "game_variant": "plo", "small_blind": 10, "big_blind": 20, "min_buy_in": 1000, "max_buy_in": 5000, "default_seats": 8, "rake_percent": 5, "rake_cap": 80, "jackpot_per_pot": 5},
              {"name": "NLH", "game_variant": "nlh", "small_blind": 2, "big_blind": 5, "min_buy_in": 200, "max_buy_in": 1000, "default_seats": 9, "rake_percent": 6, "rake_cap": 40}]:
        call("POST", "/cash-game/game-types", g)
    gts = call("GET", "/cash-game/game-types") or []
cday = call("GET", "/cash-game/days/current", ok=(200, 404))
if not cday or not cday.get("id"):
    cday = call("POST", "/cash-game/days", {"business_date": HOJE, "label": "Quinta do PLO"})
print("dia de cash:", cday and cday.get("id"))
tables = call("GET", f"/cash-game/tables?cash_day_id={cday['id']}") or []
if not tables:
    for n, gt in enumerate(gts[:2], start=1):
        call("POST", "/cash-game/tables", {"cash_day_id": cday["id"], "game_type_id": gt["id"], "table_number": n, "seats": gt.get("default_seats", 9)})
    tables = call("GET", f"/cash-game/tables?cash_day_id={cday['id']}") or []
cbc = call("GET", f"/cashboxes/me/current?cash_day_id={cday['id']}")
if cbc and cbc.get("status") != "open":
    call("POST", f"/cashboxes/{cbc['id']}/open", {"initial_balance": 500})
if tables:
    t1 = tables[0]
    seated = call("GET", f"/cash-game/tables/{t1['id']}/seats") or []
    ocupados = {s.get("player_id") for s in seated if s.get("player_id")}
    for seat, pid, amt in [(1, ids[6], 1000), (2, ids[7], 1500), (3, ids[8], 800), (5, ids[9], 2000), (7, ids[3], 1200)]:
        if pid in ocupados: continue
        call("POST", f"/cash-game/tables/{t1['id']}/seats/{seat}/sit", {"player_id": pid, "buy_in_amount": amt, "payment_method": "cash", "client_mutation_id": str(uuid.uuid4())})
    if len(tables) > 1:
        t2 = tables[1]
        for seat, pid, amt in [(1, ids[0], 2000), (4, ids[1], 3000)]:
            call("POST", f"/cash-game/tables/{t2['id']}/seats/{seat}/sit", {"player_id": pid, "buy_in_amount": amt, "payment_method": "pix", "client_mutation_id": str(uuid.uuid4())})
print("mesas:", len(tables))

# ── bar ──────────────────────────────────────────────────────────────────────
cats = call("GET", "/bar/categories") or []
if not cats:
    for nome in ["Bebidas", "Cervejas", "Drinks", "Comidas", "Petiscos"]:
        call("POST", "/bar/categories", {"name": nome})
    cats = call("GET", "/bar/categories") or []
cat = {c_["name"]: c_["id"] for c_ in cats}
prods = call("GET", "/bar/products") or []
if not prods:
    for nome, catn, preco, custo, track, mn in [("Cerveja long neck", "Cervejas", 12, 4.5, True, 6), ("Chopp 300ml", "Cervejas", 10, 3.2, False, 0),
                                                ("Água 500ml", "Bebidas", 5, 1.5, True, 12), ("Refrigerante lata", "Bebidas", 6, 2.1, True, 10),
                                                ("Energético", "Bebidas", 15, 6, True, 10), ("Gin tônica", "Drinks", 28, 9, False, 0),
                                                ("Caipirinha", "Drinks", 22, 6.5, False, 0), ("Whisky dose", "Drinks", 35, 14, False, 0),
                                                ("Porção de batata", "Petiscos", 30, 12, False, 0), ("Pastel de carne", "Petiscos", 12, 4, False, 0),
                                                ("Hambúrguer da casa", "Comidas", 38, 15, False, 0), ("Sanduíche natural", "Comidas", 18, 7, True, 4)]:
        call("POST", "/bar/products", {"name": nome, "category_id": cat.get(catn), "price": preco, "cost_price": custo, "track_stock": track, "min_stock": mn})
    prods = call("GET", "/bar/products") or []
    for p in prods:
        if p.get("track_stock"):
            call("POST", f"/bar/products/{p['id']}/stock-movements", {"kind": "in", "quantity": 24 if "Cerveja" in p["name"] else 11, "unit_cost": p.get("cost_price") or 0, "client_mutation_id": str(uuid.uuid4())})
shift = call("GET", "/bar/shifts/current", ok=(200, 404))
if not shift or not shift.get("id"):
    shift = call("POST", "/bar/shifts", {"business_date": HOJE, "label": "Quinta"})
cbb = call("GET", f"/cashboxes/me/current?bar_shift_id={shift['id']}")
if cbb and cbb.get("status") != "open":
    call("POST", f"/cashboxes/{cbb['id']}/open", {"initial_balance": 100})
tabs = call("GET", f"/bar/tabs?bar_shift_id={shift['id']}&status=open") or []
if not tabs:
    by = {p["name"]: p["id"] for p in prods}
    for pid, itens in [(ids[0], ["Cerveja long neck", "Cerveja long neck", "Porção de batata", "Gin tônica"]), (ids[1], ["Cerveja long neck", "Caipirinha"]), (ids[2], ["Hambúrguer da casa", "Whisky dose", "Água 500ml"])]:
        tab = call("POST", "/bar/tabs/open", {"player_id": pid, "client_mutation_id": str(uuid.uuid4())})
        if not tab: continue
        tid = tab["tab"]["id"] if "tab" in tab else tab["id"]
        for k, nome in enumerate(itens):
            it = call("POST", f"/bar/tabs/{tid}/items", {"product_id": by[nome], "quantity": 1, "client_mutation_id": str(uuid.uuid4())})
            if it and k % 2 == 0:
                items = (it.get("items") or [])
                if items:
                    call("POST", f"/bar/tabs/{tid}/items/{items[-1]['id']}/deliver", {})
print("comandas:", len(call("GET", f"/bar/tabs?bar_shift_id={shift['id']}&status=open") or []))
print("ok")
