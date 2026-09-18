# -*- coding: utf-8 -*-
"""Sessão temporária de ADMIN na org Teste para conferir o frontend no Chrome
headless. Cria usuário + staff, faz login por magic link e imprime a URL do app
com os tokens no hash (o supabase-js do frontend guarda a sessão ao carregar).
Roda de dentro de backend/:  venv\\Scripts\\python.exe <este arquivo> [--cleanup]
"""
import io, json, os, sys
sys.path.insert(0, os.getcwd())
from app.config import get_settings  # noqa: E402
from app.database.supabase_client import supabase_admin  # noqa: E402
import httpx  # noqa: E402

ORG = "baa825a5-422a-4424-818a-028db0bbfc1c"   # org Teste (mesma do E2E do bar)
EMAIL = "ui-preview@teste.local"
STATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".ui_preview_state.json")

def cleanup():
    if not os.path.exists(STATE):
        print("nada para limpar"); return
    st = json.load(io.open(STATE, encoding="utf-8"))
    try:
        supabase_admin.table("activity_logs").delete().eq("auth_user_id", st["auth_user"]).execute()
    except Exception as e:
        print("activity_logs:", e)
    for tabela, col in (("cashboxes", "staff_id"),):
        try:
            supabase_admin.table(tabela).delete().eq(col, st["staff"]).execute()
        except Exception as e:
            print(tabela, e)
    supabase_admin.table("staff").delete().eq("id", st["staff"]).execute()
    supabase_admin.auth.admin.delete_user(st["auth_user"])
    os.remove(STATE)
    print("limpo")

if "--cleanup" in sys.argv:
    cleanup(); sys.exit(0)

settings = get_settings()
# usuário já existe de uma rodada anterior? reaproveita
existente = json.load(io.open(STATE, encoding="utf-8")) if os.path.exists(STATE) else None
if not existente:
    # Outra sessão pode ter criado o usuário: procura pelo e-mail antes de criar.
    try:
        achado = next((u for u in supabase_admin.auth.admin.list_users() if u.email == EMAIL), None)
    except Exception:
        achado = None
    if achado:
        st = supabase_admin.table("staff").select("id").eq("auth_user_id", achado.id).eq("organization_id", ORG).execute().data
        if st:
            existente = {"auth_user": achado.id, "staff": st[0]["id"]}
            json.dump(existente, io.open(STATE, "w", encoding="utf-8"))
if existente:
    AUTH, STAFF = existente["auth_user"], existente["staff"]
else:
    novo = supabase_admin.auth.admin.create_user({"email": EMAIL, "password": "Ui!preview-" + os.urandom(6).hex(),
                                                  "email_confirm": True, "user_metadata": {"full_name": "Felipe Preview"}})
    AUTH = novo.user.id
    grupos = supabase_admin.table("permission_groups").select("id,name,permissions").eq("organization_id", ORG).execute().data
    admin = next((g for g in grupos if g["name"].lower().startswith("admin")), None) or max(grupos, key=lambda g: len(g["permissions"] or []))
    staff = supabase_admin.table("staff").insert({
        "auth_user_id": AUTH, "name": "Felipe Preview", "email": EMAIL, "active": True,
        "invite_status": "accepted", "permission_group_id": admin["id"], "organization_id": ORG,
    }).execute().data[0]
    STAFF = staff["id"]
    json.dump({"auth_user": AUTH, "staff": STAFF}, io.open(STATE, "w", encoding="utf-8"))
    print("grupo:", admin["name"])

link = supabase_admin.auth.admin.generate_link({"type": "magiclink", "email": EMAIL})
r = httpx.post(f"{settings.supabase_url}/auth/v1/verify",
               headers={"apikey": settings.supabase_anon_key, "Content-Type": "application/json"},
               json={"type": "magiclink", "token_hash": link.properties.hashed_token}, timeout=30)
r.raise_for_status()
sess = r.json()
url = ("http://localhost:3000/#access_token=" + sess["access_token"] + "&refresh_token=" + sess["refresh_token"]
       + "&expires_in=" + str(sess.get("expires_in", 3600)) + "&token_type=bearer&type=magiclink")
io.open(os.path.join(os.path.dirname(STATE), ".ui_preview_url.txt"), "w", encoding="utf-8").write(url)
print("url gravada (", len(url), "chars )")
