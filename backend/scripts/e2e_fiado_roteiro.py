"""Roteiro ponta a ponta do FIADO DA CASA no cash, pela camada de serviço
contra o banco REAL, na org Teste, com um usuário de verdade (cargo de
operador do cash, SEM fiado.manage) — o `supabase` do backend roda como ele
(RLS). As ações de gerente (liberar, baixa, estorno de recebimento) vão pelo
service role, como o router faz depois de conferir `fiado.manage`.

A org Teste está no plano free (2 usuários, 2 mesas de cash) e com o trial
vencido (suspensa). Durante o roteiro ela fica ATIVA e com +1 usuário; tudo
volta ao que era no fim, inclusive se o roteiro falhar. Usa uma mesa JÁ ABERTA
do dia (o plano não deixa abrir a terceira) e lugares livres dela.

LIMPEZA: o razão do fiado só aceita UPDATE/DELETE do dono do banco (nem o
service role apaga) e o conector do MCP recusa DELETE. O roteiro grava os ids
em `e2e_fiado_ids.json` e o SQL de limpeza em `e2e_fiado_limpeza.sql`, para
rodar no SQL Editor (como dono).

Roda de dentro de backend/: venv\\Scripts\\python.exe scripts\\e2e_fiado_roteiro.py
"""
import json
import os
import sys
import datetime as dt
import secrets
import traceback

sys.path.insert(0, os.getcwd())

import httpx  # noqa: E402
import jwt as pyjwt  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.database import supabase  # noqa: E402
from app.database.supabase_client import supabase_admin, set_request_jwt  # noqa: E402
from app.models.cash_game import CashRebuy, SitPlayer, StandPlayer  # noqa: E402
from app.models.house_credit import HouseCreditAccountUpdate, HouseCreditPaymentCreate  # noqa: E402
from app.services.cash_day_service import CashDayService  # noqa: E402
from app.services.cash_transaction_service import CashTransactionService as CTS  # noqa: E402
from app.services.cashbox_service import CashboxService as CS  # noqa: E402
from app.services.house_credit_service import HouseCreditService as HCS, recusa_do_banco  # noqa: E402
from app.utils.erros import ErroDeNegocio  # noqa: E402

ORG = "baa825a5-422a-4424-818a-028db0bbfc1c"      # org Teste
DIA = os.environ.get("E2E_CASH_DAY", "1253a0f7-2a02-4123-bfe1-45686dc4ca10")
MESA = os.environ.get("E2E_TABLE", "af9079ab-ed68-4903-82dc-8f66e15fd48c")   # mesa 2: buy-in 1000–5000
LUGARES = [int(x) for x in os.environ.get("E2E_SEATS", "2,3,5").split(",")]
HOJE = dt.date.today().isoformat()
EMAIL = f"e2e-fiado-{secrets.token_hex(3)}@teste.local"
PASTA = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.join(PASTA, "e2e_fiado_ids.json")

criados = {"players": [], "cashbox": None, "auth_user": None, "staff": None, "group": None}
passos = []
org_original = {"override": None, "status": None, "mexeu": False}


def ok(nome, cond, detalhe=""):
    passos.append((nome, bool(cond)))
    print(("OK   " if cond else "FALHA"), nome, detalhe)
    if not cond:
        raise AssertionError(f"{nome} {detalhe}")


def recusa(fn, code):
    try:
        fn()
    except ErroDeNegocio as e:
        ok(f"recusa {code}", e.code == code, f"(veio {e.code} {e.dados})")
        return e
    except Exception as exc:          # recusa crua do banco (ataque direto)
        e = recusa_do_banco(exc)
        ok(f"recusa {code}", e is not None and e.code == code, f"(veio {e.code if e else str(exc)[:160]})")
        return e
    raise AssertionError(f"esperava recusa {code}, passou")


def gaveta(cb_id):
    return float(supabase_admin.table("cashboxes").select("current_balance").eq("id", cb_id)
                 .execute().data[0]["current_balance"])


def devido(player):
    linhas = supabase_admin.table("house_credit_accounts").select("balance") \
        .eq("organization_id", ORG).eq("player_id", player).execute().data
    return float(linhas[0]["balance"]) if linhas else 0.0


def assento(n):
    return supabase_admin.table("cash_seats").select("*").eq("table_id", MESA) \
        .eq("seat_number", n).execute().data[0]


def sit(jogador, n, valor, fonte="house_credit"):
    return CTS.sit(MESA, n, SitPlayer(player_id=jogador, buy_in_amount=valor, payment_method="cash",
                                      payment_source=fonte,
                                      client_mutation_id=f"e2e-fiado-{secrets.token_hex(5)}"), AUTH, ORG)


AUTH = None
try:
    settings = get_settings()
    for n in LUGARES:
        if assento(n)["status"] != "free":
            raise SystemExit(f"lugar {n} da mesa não está livre — escolha outros em E2E_SEATS")

    # ── 0. operador REAL do cash, só na org Teste ──
    novo = supabase_admin.auth.admin.create_user({
        "email": EMAIL, "password": "E2e!" + secrets.token_urlsafe(12), "email_confirm": True,
        "user_metadata": {"e2e": "fiado"},
    })
    AUTH = novo.user.id
    criados["auth_user"] = AUTH
    grupo = supabase_admin.table("permission_groups").insert({
        "name": "E2E Cash (fiado)", "description": "E2E", "organization_id": ORG,
        "permissions": ["cash.operate", "cash.tables", "cash.admin", "cashbox.operate", "players"],
    }).execute().data[0]
    criados["group"] = grupo["id"]
    org_row = supabase_admin.table("organizations").select("max_users_override, status") \
        .eq("id", ORG).execute().data[0]
    ativos = len(supabase_admin.table("staff").select("id").eq("organization_id", ORG).eq("active", True).execute().data)
    org_original.update({"override": org_row.get("max_users_override"), "status": org_row.get("status")})
    supabase_admin.table("organizations").update(
        {"max_users_override": ativos + 1, "status": "active"}).eq("id", ORG).execute()
    org_original["mexeu"] = True
    staff = supabase_admin.table("staff").insert({
        "auth_user_id": AUTH, "name": "E2E Caixa Fiado", "email": EMAIL, "active": True,
        "invite_status": "accepted", "permission_group_id": grupo["id"], "organization_id": ORG,
    }).execute().data[0]
    criados["staff"] = staff["id"]

    link = supabase_admin.auth.admin.generate_link({"type": "magiclink", "email": EMAIL})
    r = httpx.post(f"{settings.supabase_url}/auth/v1/verify",
                   headers={"apikey": settings.supabase_anon_key, "Content-Type": "application/json"},
                   json={"type": "magiclink", "token_hash": link.properties.hashed_token}, timeout=30)
    ok("0 login do operador (magic link)", r.status_code == 200, f"status={r.status_code}")
    token = r.json()["access_token"]
    ok("0 claim organization_id = Teste",
       pyjwt.decode(token, options={"verify_signature": False}).get("organization_id") == ORG)
    set_request_jwt(token)   # daqui em diante o `supabase` roda COMO o operador (RLS)

    for nome, doc in (("E2E FIADO Ana", "E2EFIA001"), ("E2E FIADO Bruno", "E2EFIA002")):
        criados["players"].append(supabase_admin.table("players").insert({
            "name": nome, "organization_id": ORG, "document_type": "cpf", "document_number": doc,
            "phone": "+55 11 90000-0000",
        }).execute().data[0]["id"])
    A, B = criados["players"]

    ok("0 dia de cash aberto", CashDayService.get_day(DIA).get("status") == "open")
    cb = CS.get_my_current(AUTH, cash_day_id=DIA)
    criados["cashbox"] = cb.id
    CS.open_session(cb.id, AUTH, 10000.0, None)
    ok("0 gaveta do operador com 10000", gaveta(cb.id) == 10000)
    json.dump(criados, open(SAIDA, "w"))
    L1, L2, L3 = LUGARES

    # ── 1. sem conta: recusa e a cadeira fica livre ──
    recusa(lambda: sit(A, L1, 4000), "fiado_nao_habilitado")
    ok("1 cadeira continua livre", assento(L1)["status"] == "free")

    # ── 2. gerente libera (service role, como a rota com fiado.manage) ──
    conta = HCS.upsert_account(A, HouseCreditAccountUpdate(enabled=True, credit_limit=6000), AUTH, ORG)
    ok("2 conta liberada com 6000", conta.enabled and conta.available == 6000)
    try:
        supabase.table("house_credit_accounts").insert(
            {"organization_id": ORG, "player_id": B, "enabled": True, "credit_limit": 99999}).execute()
        ok("2 operador NÃO cria conta pelo navegador", False)
    except Exception as exc:
        ok("2 operador NÃO cria conta pelo navegador", "row-level security" in str(exc).lower(), str(exc)[:120])

    # ── 3. venda fiada: fora da gaveta ──
    r1 = sit(A, L1, 4000)
    venda1 = supabase_admin.table("cash_transactions").select("*").eq("id", r1.transaction.id).execute().data[0]
    ok("3 venda fiada sem gaveta e sem meio",
       venda1["payment_source"] == "house_credit" and venda1["cashbox_id"] is None and venda1["payment_method"] is None)
    ok("3 gaveta intacta (10000)", gaveta(cb.id) == 10000)
    ok("3 dívida 4000", devido(A) == 4000)
    s1 = r1.player_session.id

    # ── 4-5. limite ──
    recusa(lambda: CTS.rebuy(s1, CashRebuy(amount=3000, payment_source="house_credit"), AUTH, ORG),
           "limite_de_fiado_excedido")
    CTS.rebuy(s1, CashRebuy(amount=2000, payment_source="house_credit"), AUTH, ORG)
    ok("5 dívida no limite (6000)", devido(A) == 6000)

    # ── 6. ataques diretos com o JWT do operador ──
    recusa(lambda: supabase.table("house_credit_entries").insert({
        "organization_id": ORG, "player_id": A, "type": "write_off", "amount": 6000, "reason": "amigo"}).execute(),
        "operacao_restrita_ao_gerente")
    recusa(lambda: supabase.table("house_credit_entries").insert({
        "organization_id": ORG, "player_id": A, "type": "cashout_offset", "amount": 6000,
        "cash_transaction_id": venda1["id"]}).execute(), "lancamento_so_pelo_caixa")
    supabase.table("house_credit_accounts").update({"balance": 0, "credit_limit": 99999}).eq("player_id", A).execute()
    supabase.table("house_credit_entries").delete().eq("player_id", A).execute()
    ok("6 UPDATE/DELETE pelo navegador sem efeito", devido(A) == 6000 and len(
        supabase_admin.table("house_credit_entries").select("id").eq("player_id", A).execute().data) == 2)
    recusa(lambda: supabase.table("cash_transactions").update({"amount": 1}).eq("id", venda1["id"]).execute(),
           "lancamento_imutavel")

    # ── 7. venda normal continua entrando na gaveta ──
    rB = sit(B, L2, 5000, fonte=None)
    ok("7 buy-in em dinheiro na gaveta (15000)", gaveta(cb.id) == 15000)

    # ── 8-9. cash-out de quem deve ──
    recusa(lambda: CTS.stand(s1, StandPlayer(cash_out_amount=9000), AUTH, ORG), "jogador_com_fiado")
    recusa(lambda: CTS.stand(s1, StandPlayer(cash_out_amount=9000, debt_offset_amount=1000), AUTH, ORG),
           "motivo_do_abatimento_obrigatorio")
    CTS.stand(s1, StandPlayer(cash_out_amount=9000, debt_offset_amount=6000, payment_method="cash",
                              client_mutation_id=f"e2e-co-{secrets.token_hex(4)}"), AUTH, ORG)
    ok("9 gaveta pagou só o líquido (15000 − 3000 = 12000)", gaveta(cb.id) == 12000, f"gaveta={gaveta(cb.id)}")
    ok("9 dívida zerada", devido(A) == 0)
    sess = supabase_admin.table("cash_player_sessions").select("*").eq("id", s1).execute().data[0]
    ok("9 sessão: fichas 9000, resultado +3000",
       float(sess["total_cash_out"]) == 9000 and float(sess["result"]) == 3000, str(sess.get("result")))

    # ── 10. senta de novo, recompra fiada e estorna a recompra ──
    r2 = sit(A, L3, 3000)
    s2 = r2.player_session.id
    rb = CTS.rebuy(s2, CashRebuy(amount=1000, payment_source="house_credit"), AUTH, ORG)
    ok("10 dívida 4000", devido(A) == 4000)
    CTS.cancel(rb.id, "lançou errado", AUTH)
    ok("10 estorno da venda fiada devolve a dívida (3000)", devido(A) == 3000)
    ok("10 gaveta não mexe (12000)", gaveta(cb.id) == 12000)

    # ── 11. recebimento e estorno do recebimento ──
    mov = HCS.receive_payment(A, HouseCreditPaymentCreate(
        amount=1000, payment_method="pix", cash_day_id=DIA, client_mutation_id=f"e2e-pg-{secrets.token_hex(4)}"), AUTH, ORG)
    ok("11 recebimento: dívida 2000, gaveta 13000", devido(A) == 2000 and gaveta(cb.id) == 13000)
    ok("11 debt_payment na gaveta", len(supabase_admin.table("cashbox_transactions").select("id")
       .eq("house_credit_entry_id", mov.entry.id).eq("type", "debt_payment").execute().data) == 1)
    HCS.reverse_payment(mov.entry.id, "digitou errado", AUTH, ORG)
    ok("11 estorno do recebimento: dívida 3000, gaveta 12000", devido(A) == 3000 and gaveta(cb.id) == 12000)
    recusa(lambda: supabase.table("house_credit_entries").insert({
        "organization_id": ORG, "player_id": A, "type": "payment", "amount": 9999, "payment_method": "pix",
        "cashbox_id": cb.id}).execute(), "valor_maior_que_a_divida")

    # ── 12. baixa e estorno recusado depois de pago ──
    HCS.write_off(A, 500, "acordo E2E", AUTH, ORG)
    ok("12 baixa: dívida 2500", devido(A) == 2500)
    dev = HCS.debtors(ORG)
    ok("12 A na lista de devedores", any(d.player_id == A and d.balance == 2500 for d in dev.rows))
    recusa(lambda: CTS.cancel(r2.transaction.id, "teste", AUTH), "estorno_de_fiado_ja_quitado")
    ok("12 venda continua ativa", supabase_admin.table("cash_transactions").select("status")
       .eq("id", r2.transaction.id).execute().data[0]["status"] == "active")

    # ── 13. quita, levanta sem fichas, B levanta ──
    HCS.receive_payment(A, HouseCreditPaymentCreate(amount=2500, payment_method="cash", cash_day_id=DIA), AUTH, ORG)
    ok("13 quitado: dívida 0, gaveta 14500", devido(A) == 0 and gaveta(cb.id) == 14500)
    CTS.stand(s2, StandPlayer(cash_out_amount=0), AUTH, ORG)
    CTS.stand(rB.player_session.id, StandPlayer(cash_out_amount=5000, payment_method="cash"), AUTH, ORG)
    ok("13 gaveta 9500", gaveta(cb.id) == 9500)
    ok("13 lugares liberados", all(assento(n)["status"] == "free" for n in LUGARES))

    # ── 14. gaveta, dia, DRE ──
    resumo = CS.get_summary(cb.id)
    ok("14 esperado = saldo (9500) com colunas do fiado",
       resumo.expected_balance == 9500 and resumo.current_balance == 9500
       and resumo.total_debt_payments == 3500 and resumo.total_refunds == 1000,
       f"esp={resumo.expected_balance} rec={resumo.total_debt_payments} ref={resumo.total_refunds}")
    sessao = CS.close_session(cb.id, AUTH, 9500.0, None)
    ok("14 fechamento sem diferença", float(sessao.difference or 0) == 0, f"diff={sessao.difference}")
    demo = CS.get_demonstrativo(cash_day_id=DIA)
    minha = [s for s in demo.sessions if s.cashbox_id == cb.id]
    ok("14 demonstrativo: fiado recebido 3500, diferença 0",
       bool(minha) and minha[0].total_debt_payments == 3500 and minha[0].difference == 0)
    dia = CashDayService.summary(DIA)
    ok("14 dia: fiado 9000 · abatido 6000 · recebido 2500",
       dia.total_credit_issued == 9000 and dia.total_debt_offset == 6000 and dia.total_debt_payments == 2500,
       f"fiado={dia.total_credit_issued} abat={dia.total_debt_offset} rec={dia.total_debt_payments}")
    ok("14 DRE: baixa de 500 hoje", HCS.summarize(ORG, HOJE, HOJE)["house_credit_write_offs"] == 500)
    ok("14 abatimento a menor: nenhum (abateu o proposto)", not any(u.player_id == A for u in HCS.under_offsets(ORG)))

    logs = supabase_admin.table("activity_logs").select("id").eq("organization_id", ORG) \
        .like("event_type", "house_credit%").gte("created_at", HOJE).execute().data or []
    ok("15 log de atividade registrou o fiado", len(logs) > 0, f"{len(logs)} linhas")

    print("\nTODOS OS PASSOS OK:", sum(1 for _, c in passos if c), "/", len(passos))
except Exception:
    traceback.print_exc()
    print("\nFALHOU. Passos:", [(n, c) for n, c in passos])
finally:
    if org_original["mexeu"]:
        # O operador do E2E sai da conta de usuários ativos antes de restaurar.
        if criados["staff"]:
            supabase_admin.table("staff").update({"active": False}).eq("id", criados["staff"]).execute()
        supabase_admin.table("organizations").update({
            "max_users_override": org_original["override"], "status": org_original["status"],
        }).eq("id", ORG).execute()
        print("org restaurada: status", org_original["status"], "· limite", org_original["override"])
    json.dump(criados, open(SAIDA, "w"))
    print("ids gravados em", SAIDA, json.dumps(criados))


def sql_de_limpeza(c: dict) -> str:
    """Limpeza como DONO do banco (SQL Editor). Só toca no que é do E2E: os
    jogadores 'E2E FIADO', a gaveta do operador do E2E e o próprio operador."""
    jog = ", ".join(f"'{p}'" for p in c["players"]) or "NULL"
    linhas = [
        "BEGIN;",
        f"DELETE FROM public.house_credit_entries WHERE player_id IN ({jog});",
        f"DELETE FROM public.house_credit_accounts WHERE player_id IN ({jog});",
    ]
    if c["cashbox"]:
        linhas.append(f"DELETE FROM public.cashbox_transactions WHERE cashbox_id = '{c['cashbox']}';")
    linhas += [
        f"DELETE FROM public.cashbox_transactions WHERE cash_transaction_id IN "
        f"(SELECT id FROM public.cash_transactions WHERE player_id IN ({jog}));",
        f"UPDATE public.cash_seats SET status = 'free', player_session_id = NULL "
        f"WHERE player_session_id IN (SELECT id FROM public.cash_player_sessions WHERE player_id IN ({jog}));",
        f"DELETE FROM public.cash_transactions WHERE player_id IN ({jog});",
        f"DELETE FROM public.cash_player_sessions WHERE player_id IN ({jog});",
    ]
    if c["cashbox"]:
        cb = c["cashbox"]
        linhas += [
            f"UPDATE public.cashboxes SET current_session_id = NULL WHERE id = '{cb}';",
            f"DELETE FROM public.cashbox_sessions WHERE cashbox_id = '{cb}';",
            f"DELETE FROM public.cashboxes WHERE id = '{cb}';",
        ]
    linhas.append(f"DELETE FROM public.players WHERE id IN ({jog}) AND name LIKE 'E2E FIADO %';")
    if c["auth_user"]:
        linhas.append(f"DELETE FROM public.activity_logs WHERE auth_user_id = '{c['auth_user']}';")
    if c["staff"]:
        linhas.append(f"DELETE FROM public.staff WHERE id = '{c['staff']}';")
    if c["group"]:
        linhas.append(f"DELETE FROM public.permission_groups WHERE id = '{c['group']}' AND name = 'E2E Cash (fiado)';")
    if c["auth_user"]:
        linhas.append(f"DELETE FROM auth.users WHERE id = '{c['auth_user']}' AND email LIKE 'e2e-fiado-%';")
    linhas.append("COMMIT;")
    return "\n".join(linhas)


sql = sql_de_limpeza(criados)
open(os.path.join(PASTA, "e2e_fiado_limpeza.sql"), "w", encoding="utf-8").write(sql)
print("\n-- LIMPEZA (rodar no SQL Editor, como dono do banco) --\n" + sql)
