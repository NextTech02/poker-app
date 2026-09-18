# -*- coding: utf-8 -*-
"""Screenshots do app local (localhost:3000) logado, com um perfil persistente
do Chrome headless. A sessão vem da URL gravada por backend/scripts/ui_preview_session.py.
Uso: python ui_shot.py login            -> abre a URL com os tokens (guarda a sessão no perfil)
     python ui_shot.py /home /caixa ...  -> screenshot (1440x900, meia escala) de cada rota em .shots/
No Git Bash, prefixe com MSYS_NO_PATHCONV=1 para "/home" não virar um caminho do Windows.
"""
import io, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, ".chrome_profile")
OUT = os.path.join(HERE, ".shots")
os.makedirs(OUT, exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

def run(url, png, w=1440, h=900, budget=12000, scale=0.5):
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
           "--disable-extensions", "--mute-audio", f"--user-data-dir={PROFILE}", f"--window-size={w},{h}",
           f"--force-device-scale-factor={scale}", f"--virtual-time-budget={budget}", f"--screenshot={png}", url]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    return os.path.exists(png)

args = sys.argv[1:]
if args and args[0] == "login":
    url = io.open(os.path.join(HERE, "..", "..", "backend", "scripts", ".ui_preview_url.txt"), encoding="utf-8").read().strip()
    print("login:", run(url, os.path.join(OUT, "_login.png"), budget=20000))
    sys.exit(0)
for rota in args:
    nome = rota.strip("/").replace("/", "_") or "home"
    png = os.path.join(OUT, nome + ".png")
    print(rota, "->", run("http://localhost:3000" + rota, png), os.path.getsize(png) // 1024 if os.path.exists(png) else 0, "KB")
