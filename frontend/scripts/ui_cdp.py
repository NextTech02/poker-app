# -*- coding: utf-8 -*-
"""Screenshot do app local guiado pelo DevTools Protocol: permite preparar o
estado do navegador (localStorage, cliques) antes de capturar — o que o
`--screenshot` do ui_shot.py não faz. Usa o mesmo perfil persistente (a sessão
gravada pelo `ui_shot.py login`).

Uso:
  python ui_cdp.py /etapas
  python ui_cdp.py /etapas --ls selected_stage='{"id":"...","name":"..."}'
  python ui_cdp.py /caixa --click 'button.x' --wait 800
  python ui_cdp.py /etapas --width 1440 --height 900 --out .shots/etapas_sel.png

Precisa do pacote `websocket-client` (python -m pip install websocket-client).
No Git Bash, prefixe com MSYS_NO_PATHCONV=1 para "/etapas" não virar caminho.
"""
import argparse, json, os, subprocess, sys, time, base64, socket
import urllib.request
import websocket

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, ".chrome_profile")
OUT = os.path.join(HERE, ".shots")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

ap = argparse.ArgumentParser()
ap.add_argument("route")
ap.add_argument("--ls", action="append", default=[], help="chave=valor no localStorage antes de carregar a rota")
ap.add_argument("--click", action="append", default=[], help="seletor CSS para clicar depois de carregar")
ap.add_argument("--wait", type=int, default=1500, help="ms de espera depois de carregar / clicar")
ap.add_argument("--width", type=int, default=1440)
ap.add_argument("--height", type=int, default=900)
ap.add_argument("--scale", type=float, default=0.5)
ap.add_argument("--out")
ap.add_argument("--port", type=int, default=9333)
a = ap.parse_args()

os.makedirs(OUT, exist_ok=True)
png = a.out or os.path.join(OUT, (a.route.strip("/").replace("/", "_") or "home") + ".png")

proc = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                         "--no-default-browser-check", "--disable-extensions", "--mute-audio",
                         f"--user-data-dir={PROFILE}", f"--window-size={a.width},{a.height}",
                         f"--force-device-scale-factor={a.scale}", f"--remote-debugging-port={a.port}", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    # Espera a porta de depuração abrir.
    for _ in range(100):
        try:
            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{a.port}/json"))
            page = next(t for t in targets if t["type"] == "page")
            break
        except Exception:
            time.sleep(0.2)
    else:
        sys.exit("chrome não abriu a porta de depuração")

    ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True)
    seq = [0]

    def send(method, **params):
        seq[0] += 1
        ws.send(json.dumps({"id": seq[0], "method": method, "params": params}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == seq[0]:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def js(expr):
        return send("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True).get("result", {}).get("value")

    send("Page.enable")
    send("Runtime.enable")
    # Primeiro a origem (para o localStorage ser o do app), depois o estado, depois a rota.
    send("Page.navigate", url="http://localhost:3000/login")
    time.sleep(1.0)
    for par in a.ls:
        chave, valor = par.split("=", 1)
        js(f"localStorage.setItem({json.dumps(chave)}, {json.dumps(valor)})")
    send("Page.navigate", url="http://localhost:3000" + a.route)
    time.sleep(a.wait / 1000)
    for sel in a.click:
        ok = js(f"(function(){{const el=document.querySelector({json.dumps(sel)}); if(!el) return false; el.click(); return true;}})()")
        print("click", sel, "->", ok)
        time.sleep(a.wait / 1000)
    shot = send("Page.captureScreenshot", format="png")
    io_png = open(png, "wb"); io_png.write(base64.b64decode(shot["data"])); io_png.close()
    print(a.route, "->", png, os.path.getsize(png) // 1024, "KB")
    ws.close()
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
