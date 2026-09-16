"""Roteiro ponta a ponta do módulo de bar (seção H do plano), pela camada de
serviço contra o banco REAL (service_role), na org Teste. Limpa tudo no fim.

Roda de dentro de backend/: venv\\Scripts\\python.exe <este arquivo>
"""
import os
import sys
import datetime as dt
import traceback

sys.path.insert(0, os.getcwd())

import secrets  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.database import supabase  # noqa: E402
from app.database.supabase_client import supabase_admin, set_request_jwt  # noqa: E402
from app.models.bar import (  # noqa: E402
    BarPaymentLeg, BarProductCreate, BarShiftCreate, BarStockMovementCreate, BarTabClose,
    BarTabDiscount, BarTabItemCreate, BarTabOpen, BarTabPay,
)
from app.services.bar_product_service import BarProductService as BPS  # noqa: E402
from app.services.bar_report_service import BarReportService as BRS  # noqa: E402
from app.services.bar_shift_service import BarShiftService as BSS  # noqa: E402
from app.services.bar_tab_service import BarTabService as BTS  # noqa: E402
from app.services.cashbox_service import CashboxService as CS  # noqa: E402
from app.services.financial_service import FinancialService  # noqa: E402
from app.utils.erros import ErroDeNegocio  # noqa: E402

ORG = "baa825a5-422a-4424-818a-028db0bbfc1c"
SPONSOR = "be62d63a-975d-4df9-9fe7-a23da0873274"
HOJE = dt.date.today().isoformat()
EMAIL = "e2e-bar@teste.local"
SENHA = "E2e!" + secrets.token_urlsafe(12)

criados = {"players": [], "credits": [], "products": [], "shift": None, "cashbox": None,
           "auth_user": None, "staff": None}
AUTH = None
STAFF = None
passos = []


def ok(nome, cond, detalhe=""):
    passos.append((nome, bool(cond), detalhe))
    print(("OK   " if cond else "FALHA"), nome, detalhe)
    if not cond:
        raise AssertionError(nome + " " + str(detalhe))


def recusa(fn, code):
    try:
        fn()
    except ErroDeNegocio as e:
        ok(f"recusa {code}", e.code == code, f"(veio {e.code})")
        return e
    raise AssertionError(f"esperava recusa {code}, passou")


def saldo_gaveta(cb_id):
    return float(supabase_admin.table("cashboxes").select("current_balance").eq("id", cb_id).execute().data[0]["current_balance"])


def estoque(pid):
    return int(supabase_admin.table("bar_products").select("stock_qty").eq("id", pid).execute().data[0]["stock_qty"])


def limpar():
    print("\n-- limpeza --")
    adm = supabase_admin
    shift = criados["shift"]
    if shift:
        tabs = [t["id"] for t in adm.table("bar_tabs").select("id").eq("bar_shift_id", shift).execute().data or []]
        pays = [p["id"] for p in adm.table("bar_tab_payments").select("id").eq("bar_shift_id", shift).execute().data or []]
        if pays:
            adm.table("cashbox_transactions").delete().in_("bar_payment_id", pays).execute()
            adm.table("credit_transactions").delete().in_("bar_payment_id", pays).execute()
        adm.table("bar_tab_payments").delete().eq("bar_shift_id", shift).execute()
        adm.table("bar_stock_movements").delete().in_("product_id", criados["products"] or ["-"]).execute()
        adm.table("bar_tab_items").delete().eq("bar_shift_id", shift).execute()
        if tabs:
            adm.table("bar_tabs").delete().in_("id", tabs).execute()
        cbs = adm.table("cashboxes").select("id").eq("bar_shift_id", shift).execute().data or []
        for cb in cbs:
            adm.table("cashboxes").update({"current_session_id": None}).eq("id", cb["id"]).execute()
            adm.table("cashbox_transactions").delete().eq("cashbox_id", cb["id"]).execute()
            adm.table("cashbox_sessions").delete().eq("cashbox_id", cb["id"]).execute()
            adm.table("cashboxes").delete().eq("id", cb["id"]).execute()
        adm.table("bar_shifts").delete().eq("id", shift).execute()
    if criados["products"]:
        adm.table("bar_products").delete().in_("id", criados["products"]).execute()
    if criados["credits"]:
        adm.table("credit_transactions").delete().in_("credit_id", criados["credits"]).execute()
        adm.table("player_credits").delete().in_("id", criados["credits"]).execute()
    if criados["players"]:
        adm.table("players").delete().in_("id", criados["players"]).execute()
    if criados["auth_user"]:
        adm.table("activity_logs").delete().eq("auth_user_id", criados["auth_user"]).execute()
    if criados["staff"]:
        adm.table("staff").delete().eq("id", criados["staff"]).execute()
    if criados.get("group"):
        adm.table("permission_groups").delete().eq("id", criados["group"]).execute()
    if criados["auth_user"]:
        try:
            adm.auth.admin.delete_user(criados["auth_user"])
        except Exception as e:
            print("usuario nao removido:", e)
    print("limpo")


try:
    # ── usuário REAL do cargo "Bar", só na org Teste ──
    # (um platform admin tem staff em várias orgs; sob service_role, sem RLS,
    #  get_staff_id_for_user pegaria a errada. O barman de verdade só tem uma.)
    settings = get_settings()
    novo = supabase_admin.auth.admin.create_user({
        "email": EMAIL, "password": SENHA, "email_confirm": True,
        "user_metadata": {"e2e": "bar"},
    })
    AUTH = novo.user.id
    criados["auth_user"] = AUTH
    grupo = supabase_admin.table("permission_groups").select("id").eq("organization_id", ORG).eq("name", "Bar").execute().data
    if not grupo:
        # Org existente: cargos_padrao só semeia org NOVA; o clube cria o cargo
        # em Funcionários. Aqui criamos (e apagamos no fim).
        grupo = supabase_admin.table("permission_groups").insert({
            "name": "Bar", "description": "E2E", "organization_id": ORG,
            "permissions": ["bar.operate", "cashbox.operate", "players"],
        }).execute().data
        criados["group"] = grupo[0]["id"]
    ok("0 cargo Bar disponível", bool(grupo))
    staff = supabase_admin.table("staff").insert({
        "auth_user_id": AUTH, "name": "E2E Barman", "email": EMAIL, "active": True,
        "invite_status": "accepted", "permission_group_id": grupo[0]["id"], "organization_id": ORG,
    }).execute().data[0]
    STAFF = staff["id"]
    criados["staff"] = STAFF
    # Login: o /token por senha exige captcha (hCaptcha ligado). O caminho sem
    # captcha é o magic link gerado pelo admin + /verify com o token_hash — a
    # sessão que sai é IGUAL à do login normal (mesmo Auth Hook, mesmos claims).
    import httpx
    link = supabase_admin.auth.admin.generate_link({"type": "magiclink", "email": EMAIL})
    hashed = link.properties.hashed_token
    r = httpx.post(f"{settings.supabase_url}/auth/v1/verify",
                   headers={"apikey": settings.supabase_anon_key, "Content-Type": "application/json"},
                   json={"type": "magiclink", "token_hash": hashed}, timeout=30)
    ok("0 login do barman (magic link)", r.status_code == 200, r.text[:200])
    token = r.json()["access_token"]
    import jwt as pyjwt
    claims = pyjwt.decode(token, options={"verify_signature": False})
    ok("0 claim organization_id = Teste (Auth Hook)", claims.get("organization_id") == ORG, str(claims.get("organization_id")))
    set_request_jwt(token)   # daqui em diante o `supabase` do backend roda COMO o barman (RLS)

    # ── setup ──
    for nome, doc in (("E2E BAR Ana", "E2EBAR001"), ("E2E BAR Bruno", "E2EBAR002")):
        row = supabase_admin.table("players").insert({
            "name": nome, "organization_id": ORG, "nationality": "BR",
            "document_type": "cpf", "document_number": doc,
            "email": f"{doc.lower()}@e2e.bar", "phone": "000",
        }).execute().data[0]
        criados["players"].append(row["id"])
    A, B = criados["players"]
    cred = supabase_admin.table("player_credits").insert({
        "player_id": A, "sponsor_id": SPONSOR, "original_amount": 15, "remaining_amount": 15,
        "used_amount": 0, "status": "active", "sponsor_owes": 0, "organization_id": ORG,
        "notes": "E2E BAR",
    }).execute().data[0]
    criados["credits"].append(cred["id"])

    cerveja = BPS.create_product(BarProductCreate(name="E2E Cerveja", price=10, cost_price=4, track_stock=True, min_stock=6), ORG)
    agua = BPS.create_product(BarProductCreate(name="E2E Água", price=5, cost_price=1.5, track_stock=True, min_stock=20), ORG)
    porcao = BPS.create_product(BarProductCreate(name="E2E Porção", price=30, cost_price=12), ORG)
    criados["products"] = [cerveja.id, agua.id, porcao.id]
    BPS.add_stock_movement(cerveja.id, BarStockMovementCreate(kind="in", quantity=24), AUTH, ORG)
    BPS.add_stock_movement(agua.id, BarStockMovementCreate(kind="in", quantity=12), AUTH, ORG)
    ok("1 estoque inicial via trigger", estoque(cerveja.id) == 24 and estoque(agua.id) == 12,
       f"cerveja={estoque(cerveja.id)} agua={estoque(agua.id)}")
    ok("1 água já nasce com estoque baixo", any(p.id == agua.id for p in BPS.low_stock(ORG)))

    # ── 2 turno ──
    turno = BSS.open_shift(BarShiftCreate(business_date=HOJE, label="E2E"), AUTH, ORG)
    criados["shift"] = turno.id
    ok("2 turno aberto", turno.status == "open" and BSS.get_current(ORG).id == turno.id)
    recusa(lambda: BSS.open_shift(BarShiftCreate(business_date=HOJE), AUTH, ORG), "turno_ja_aberto")

    # ── 3 gaveta ──
    cb = CS.get_my_current(AUTH, bar_shift_id=turno.id)
    ok("3 gaveta ancorada no turno", cb.bar_shift_id == turno.id and cb.stage_id is None and cb.cash_day_id is None)
    criados["cashbox"] = cb.id
    CS.open_session(cb.id, AUTH, 100.0, None)
    ok("3 gaveta com 100", saldo_gaveta(cb.id) == 100)

    # ── 4-5 comanda A ──
    a = BTS.open_tab(BarTabOpen(player_id=A), AUTH, ORG)
    ok("4 comanda A nº1", a.number == 1 and a.status == "open")
    mesma = BTS.open_tab(BarTabOpen(player_id=A), AUTH, ORG)
    ok("4 comanda única por jogador", mesma.id == a.id)
    d = BTS.add_item(a.id, BarTabItemCreate(product_id=cerveja.id, quantity=2), AUTH)
    d = BTS.deliver_item(a.id, d.items[0].id, AUTH)
    ok("4 estoque 22 / subtotal 20", estoque(cerveja.id) == 22 and d.tab.subtotal == 20 and d.tab.balance_due == 20,
       f"estoque={estoque(cerveja.id)} sub={d.tab.subtotal}")
    d = BTS.add_item(a.id, BarTabItemCreate(product_id=porcao.id), AUTH)
    ok("5 subtotal 50", d.tab.subtotal == 50 and d.tab.balance_due == 50)
    # o banco recontou igual ao serviço
    linha = supabase_admin.table("bar_tabs").select("subtotal,total,paid_amount").eq("id", a.id).execute().data[0]
    ok("5 trigger recontou a comanda", float(linha["subtotal"]) == 50 and float(linha["total"]) == 50)

    # ── 6 paga 20 pix ──
    d = BTS.pay(a.id, BarTabPay(legs=[BarPaymentLeg(payment_method="pix", amount=20)], client_mutation_id="e2e-pay-1"), AUTH, ORG)
    ok("6 gaveta 120 / saldo 30", saldo_gaveta(cb.id) == 120 and d.tab.balance_due == 30, f"gaveta={saldo_gaveta(cb.id)}")
    d2 = BTS.pay(a.id, BarTabPay(legs=[BarPaymentLeg(payment_method="pix", amount=20)], client_mutation_id="e2e-pay-1"), AUTH, ORG)
    ok("6 duplo clique não cobra de novo", saldo_gaveta(cb.id) == 120 and d2.tab.paid_amount == 20)
    recusa(lambda: BTS.pay(a.id, BarTabPay(legs=[BarPaymentLeg(payment_method="pix", amount=31)]), AUTH, ORG), "pagamento_acima_do_saldo")

    # ── 7 split crédito 15 + dinheiro 15 ──
    ok("7 crédito disponível 15", BTS.detail(a.id).player_available_credit == 15)
    d = BTS.pay(a.id, BarTabPay(legs=[
        BarPaymentLeg(payment_method="credit", amount=15, payment_source="credit"),
        BarPaymentLeg(payment_method="cash", amount=15),
    ]), AUTH, ORG)
    ok("7 gaveta 135 (crédito não entra) / saldo 0", saldo_gaveta(cb.id) == 135 and d.tab.balance_due == 0, f"gaveta={saldo_gaveta(cb.id)}")
    ct = supabase_admin.table("credit_transactions").select("type,tournament_id,bar_payment_id").eq("credit_id", cred["id"]).execute().data
    ok("7 credit_used_bar sem torneio", len(ct) == 1 and ct[0]["type"] == "credit_used_bar" and ct[0]["tournament_id"] is None and ct[0]["bar_payment_id"])
    ok("7 crédito restante 0", BTS.detail(a.id).player_available_credit == 0)
    recusa(lambda: BTS.close_tab(a.id, BarTabClose(), AUTH), "comanda_com_pedido_pendente")
    a_fechada = BTS.close_tab(a.id, BarTabClose(deliver_pending=True), AUTH)
    ok("7 comanda A fechada (entregando a Porção pendente)", a_fechada.status == "closed")

    # ── 8 comanda B: saiu sem pagar ──
    b = BTS.open_tab(BarTabOpen(player_id=B), AUTH, ORG)
    d = BTS.add_item(b.id, BarTabItemCreate(product_id=agua.id), AUTH)
    d = BTS.set_discount(b.id, BarTabDiscount(amount=5, reason="saiu sem pagar"), AUTH)
    ok("8 total 0 após desconto", d.tab.total == 0 and d.tab.balance_due == 0)
    b_fechada = BTS.close_tab(b.id, BarTabClose(deliver_pending=True), AUTH)
    ok("8 B fechada sem pagamento / gaveta 135 / água 11", b_fechada.status == "closed" and saldo_gaveta(cb.id) == 135 and estoque(agua.id) == 11)

    # ── 9 comanda C: 3 cervejas, cancela 1 ──
    c = BTS.open_tab(BarTabOpen(player_id=A), AUTH, ORG)
    ok("9 A pode abrir outra comanda depois de fechar a primeira", c.id != a.id and c.number == 3)
    for _ in range(3):
        d = BTS.add_item(c.id, BarTabItemCreate(product_id=cerveja.id), AUTH)
    ok("9 estoque 19", estoque(cerveja.id) == 19, f"estoque={estoque(cerveja.id)}")
    d = BTS.cancel_item(c.id, d.items[-1].id, "lançou errado", AUTH, pode_admin=False)
    ok("9 cancelar devolve: estoque 20 / subtotal 20", estoque(cerveja.id) == 20 and d.tab.subtotal == 20, f"estoque={estoque(cerveja.id)} sub={d.tab.subtotal}")

    # ── 10 paga, estorna, paga de novo ──
    d = BTS.pay(c.id, BarTabPay(legs=[BarPaymentLeg(payment_method="cash", amount=20)]), AUTH, ORG)
    ok("10 gaveta 155", saldo_gaveta(cb.id) == 155)
    d = BTS.cancel_payment(c.id, d.payments[0].id, "cobrado errado", AUTH)
    ok("10 estorno: gaveta 135 / saldo 20", saldo_gaveta(cb.id) == 135 and d.tab.balance_due == 20, f"gaveta={saldo_gaveta(cb.id)}")
    d = BTS.cancel_payment(c.id, d.payments[0].id, "cobrado errado", AUTH)
    ok("10 estorno repetido não devolve de novo", saldo_gaveta(cb.id) == 135)
    d = BTS.pay(c.id, BarTabPay(legs=[BarPaymentLeg(payment_method="card", amount=20)]), AUTH, ORG)
    ok("10 gaveta 155", saldo_gaveta(cb.id) == 155)
    BTS.close_tab(c.id, BarTabClose(deliver_pending=True), AUTH)

    # ── 11 comanda D e o fechamento bloqueado ──
    dd = BTS.open_tab(BarTabOpen(player_id=B), AUTH, ORG)
    BTS.add_item(dd.id, BarTabItemCreate(product_id=agua.id), AUTH)
    ok("11 água 10", estoque(agua.id) == 10)
    e = recusa(lambda: BSS.close_shift(turno.id, AUTH), "turno_com_comanda_aberta")
    ok("11 recusa lista a nº4", e.dados["quantidade"] == 1 and e.dados["comandas"][0]["number"] == 4 and e.dados["comandas"][0]["balance_due"] == 5, str(e.dados))
    BTS.pay(dd.id, BarTabPay(legs=[BarPaymentLeg(payment_method="cash", amount=5)]), AUTH, ORG)
    BTS.close_tab(dd.id, BarTabClose(deliver_pending=True), AUTH)
    ok("11 gaveta 160", saldo_gaveta(cb.id) == 160, f"gaveta={saldo_gaveta(cb.id)}")

    # ── 12 gaveta e turno ──
    recusa(lambda: BSS.close_shift(turno.id, AUTH), "turno_com_caixa_aberto")
    resumo_cb = CS.get_summary(cb.id)
    ok("12 get_summary: esperado 160 = gaveta, bar_sales 80, refunds 20",
       resumo_cb.expected_balance == 160 and resumo_cb.current_balance == 160 and resumo_cb.total_bar_sales == 80 and resumo_cb.total_refunds == 20,
       f"esp={resumo_cb.expected_balance} bar={resumo_cb.total_bar_sales} ref={resumo_cb.total_refunds}")
    sessao = CS.close_session(cb.id, AUTH, 160.0, None)
    ok("12 fechamento da gaveta sem diferença", float(sessao.difference or 0) == 0, f"diff={sessao.difference}")
    demo = CS.get_demonstrativo(bar_shift_id=turno.id)
    ok("12 demonstrativo do turno", len(demo.sessions) == 1 and demo.sessions[0].total_bar_sales == 80 and demo.sessions[0].total_refunds == 20
       and demo.sessions[0].expected_balance == 160 and demo.sessions[0].difference == 0 and demo.sessions[0].bar_shift_label == "E2E",
       f"{demo.sessions[0].model_dump() if demo.sessions else 'sem sessão'}")
    t = BSS.close_shift(turno.id, AUTH, notes="e2e")
    ok("12 turno congelado", t.status == "closed" and t.total_gross == 80 and t.total_discounts == 5 and t.total_net == 75
       and t.total_paid == 75 and t.total_paid_cash == 60 and t.total_paid_credit == 15 and t.total_cogs == 31 and t.tabs_count == 4,
       f"gross={t.total_gross} disc={t.total_discounts} net={t.total_net} paid={t.total_paid} cash={t.total_paid_cash} cred={t.total_paid_credit} cogs={t.total_cogs} tabs={t.tabs_count}")
    s = BSS.summary(turno.id)
    ok("12 summary congelado: margem 44", s.gross_margin == 44 and s.by_method and sum(m.amount for m in s.by_method) == 75)

    # ── 13 DRE ──
    dre_bar = BRS.summarize(ORG, HOJE, HOJE)
    ok("13 resumo do bar p/ DRE", dre_bar["bar_revenue"] == 75 and dre_bar["bar_cogs"] == 31 and dre_bar["bar_discounts"] == 5 and dre_bar["bar_tabs_count"] == 4, str(dre_bar))
    dre = FinancialService.get_financial_summary(stage_id="00000000-0000-0000-0000-000000000000", organization_id=ORG, start_date=HOJE, end_date=HOJE)
    ok("13 DRE (etapa sem torneio) soma o bar no bruto e NÃO subtrai CMV",
       dre.bar_revenue == 75 and dre.gross_revenue == dre.cash_revenue + 75 and dre.bar_cogs == 31
       and abs(dre.net_result - (dre.gross_revenue + dre.other_revenue - dre.expenses)) < 0.01,
       f"gross={dre.gross_revenue} cash={dre.cash_revenue} net={dre.net_result} exp={dre.expenses} outras={dre.other_revenue}")
    rel = BRS.summary(ORG, HOJE, HOJE)
    ok("13 relatório: top produto Cerveja 4 un", rel.top_products[0].product_name == "E2E Cerveja" and rel.top_products[0].quantity == 4, str(rel.top_products[:1]))
    hist = BTS.player_history(A)
    ok("13 histórico do jogador A: 2 comandas", len([h for h in hist if h.bar_shift_id == turno.id]) == 2)

    # ── 16 log de atividade ──
    logs = supabase_admin.table("activity_logs").select("event_type, entity_table").eq("organization_id", ORG) \
        .in_("entity_table", ["bar_tabs", "bar_tab_payments", "bar_shifts"]).order("created_at", desc=True).limit(50).execute().data or []
    ok("16 activity_logs registrou o bar", len(logs) > 0, f"{len(logs)} linhas")

    print("\nTODOS OS PASSOS OK:", sum(1 for _, c, _ in passos if c), "/", len(passos))
except Exception:
    traceback.print_exc()
    print("\nFALHOU. Passos:", [(n, c) for n, c, _ in passos])
finally:
    limpar()
