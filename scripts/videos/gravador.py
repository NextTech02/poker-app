# -*- coding: utf-8 -*-
"""Grava o app no Chrome sem cabeça, quadro a quadro.

Usa Page.startScreencast e não o recordVideo do Playwright: o recordVideo tem
taxa de bits fixa e borra texto pequeno, e aqui o texto da tela é o conteúdo.
A janela é 1536x864 de propósito: em 1920 a interface fica pequena demais num
player embutido. O screencast entrega o quadro no tamanho da janela, ignorando
a escala do dispositivo, então não há como pedir mais pixels por aqui.
"""
import asyncio
import base64
import json
import time
from pathlib import Path

from playwright.async_api import async_playwright

LARGURA, ALTURA = 1536, 864
LOGO = Path(__file__).resolve().parents[2] / "frontend" / "src" / "assets" / "aceblind-logo-white.png"

# Cursor, destaque e cartões vivem no DOM da página para saírem na captura.
# `pointer-events: none` em tudo: nada disto pode interceptar um clique real.
CAMADA = r"""
(() => {
  if (window.__ace) return;
  const CSS = `
  #__ace_cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483646;pointer-events:none;
    transition:transform var(--ace-ms,600ms) cubic-bezier(.45,.05,.25,1);filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
  .__ace_onda{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;z-index:2147483645;
    pointer-events:none;border:3px solid #b79bfb;animation:__ace_onda .55s ease-out forwards}
  @keyframes __ace_onda{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
  #__ace_destaque{position:fixed;z-index:2147483644;pointer-events:none;border-radius:10px;border:3px solid #b79bfb;
    box-shadow:0 0 0 9999px rgba(0,0,0,.38);opacity:0;transition:opacity .28s ease}
  #__ace_cartao{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px;background:radial-gradient(1100px 620px at 50% 118%,#4015a0 0%,#0b0a12 68%);color:#f3f1f8;opacity:0;
    transition:opacity .45s ease;font-family:Inter,Segoe UI,Arial,sans-serif;text-align:center;padding:0 120px}
  #__ace_cartao .marca{height:84px;margin-bottom:10px}
  #__ace_cartao .titulo{font-size:50px;font-weight:700;line-height:1.15;max-width:1150px}
  #__ace_cartao .sub{font-size:22px;color:#aaa7bb;max-width:950px;line-height:1.4}`;
  const SETA = `<svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" stroke="#111" stroke-width="1.6"
    stroke-linejoin="round" d="M4 2.5 19.5 13l-7 1.3L9 21z"/></svg>`;
  function monta() {
    if (document.getElementById('__ace_cursor') || !document.body) return;
    const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = '__ace_cursor'; c.innerHTML = SETA;
    c.style.transform = `translate(${innerWidth * .5}px,${innerHeight * .55}px)`;
    document.body.appendChild(c);
    const d = document.createElement('div'); d.id = '__ace_destaque'; document.body.appendChild(d);
    const k = document.createElement('div'); k.id = '__ace_cartao'; document.body.appendChild(k);
  }
  window.__ace = {
    monta,
    mover(x, y, ms) { monta(); const c = document.getElementById('__ace_cursor');
      c.style.setProperty('--ace-ms', ms + 'ms'); c.style.transform = `translate(${x}px,${y}px)`; },
    onda(x, y) { const o = document.createElement('div'); o.className = '__ace_onda';
      o.style.left = x + 'px'; o.style.top = y + 'px'; document.body.appendChild(o); setTimeout(() => o.remove(), 600); },
    destaque(x, y, w, h) { monta(); const d = document.getElementById('__ace_destaque'); const m = 8;
      Object.assign(d.style, { left: x - m + 'px', top: y - m + 'px', width: w + 2 * m + 'px', height: h + 2 * m + 'px', opacity: 1 }); },
    semDestaque() { const d = document.getElementById('__ace_destaque'); if (d) d.style.opacity = 0; },
    cartao(titulo, sub, marca) { monta(); const k = document.getElementById('__ace_cartao');
      k.innerHTML = ''; const l = document.createElement('img'); l.className = 'marca'; l.src = marca; k.appendChild(l);
      [['titulo', titulo], ['sub', sub]].forEach(([cl, tx]) => {
        if (!tx) return; const e = document.createElement('div'); e.className = cl; e.textContent = tx; k.appendChild(e); });
      k.style.opacity = 1; },
    semCartao() { const k = document.getElementById('__ace_cartao'); if (k) k.style.opacity = 0; },
  };
  document.addEventListener('DOMContentLoaded', monta);
})();
"""


class Gravador:
    """Sessão de navegador + captura. Use com `async with`."""

    def __init__(self, pasta: Path, idioma: str, armazenamento: dict | None = None):
        self.pasta = Path(pasta)
        self.idioma = idioma
        self.armazenamento = armazenamento or {}
        self.quadros: list[tuple[str, float]] = []
        self.pos = (LARGURA * 0.5, ALTURA * 0.55)
        self._acks: set = set()

    async def __aenter__(self):
        self.pasta.mkdir(parents=True, exist_ok=True)
        self.pw = await async_playwright().start()
        self.navegador = await self.pw.chromium.launch()
        self.contexto = await self.navegador.new_context(
            viewport={"width": LARGURA, "height": ALTURA},
            locale=self.idioma,
            timezone_id="America/Sao_Paulo",
        )
        await self.contexto.add_init_script(CAMADA)
        if self.armazenamento:
            valores = json.dumps(self.armazenamento)
            await self.contexto.add_init_script(
                f"for (const [k, v] of Object.entries({valores})) localStorage.setItem(k, v);"
            )
        self.pagina = await self.contexto.new_page()
        # Sem isto o Playwright recusa todo confirm() nativo da página.
        self.pagina.on("dialog", lambda dialogo: asyncio.ensure_future(dialogo.accept()))
        self.cdp = await self.contexto.new_cdp_session(self.pagina)
        self.cdp.on("Page.screencastFrame", self._quadro)
        return self

    async def __aexit__(self, *_):
        await self.navegador.close()
        await self.pw.stop()

    def _quadro(self, dados: dict) -> None:
        nome = f"q{len(self.quadros):07d}.jpg"
        (self.pasta / nome).write_bytes(base64.b64decode(dados["data"]))
        self.quadros.append((nome, dados["metadata"]["timestamp"]))
        tarefa = asyncio.ensure_future(
            self.cdp.send("Page.screencastFrameAck", {"sessionId": dados["sessionId"]})
        )
        self._acks.add(tarefa)
        tarefa.add_done_callback(self._acks.discard)

    async def iniciar_captura(self) -> None:
        await self.cdp.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1},
        )
        self.t0 = time.time()

    async def parar_captura(self) -> float:
        await self.cdp.send("Page.stopScreencast")
        return time.time()

    # ── gestos ───────────────────────────────────────────────────────────────
    async def _centro(self, alvo) -> tuple[float, float, dict]:
        await alvo.wait_for(state="visible", timeout=15000)
        await alvo.scroll_into_view_if_needed()
        caixa = await alvo.bounding_box()
        return caixa["x"] + caixa["width"] / 2, caixa["y"] + caixa["height"] / 2, caixa

    async def mover(self, x: float, y: float) -> None:
        distancia = ((x - self.pos[0]) ** 2 + (y - self.pos[1]) ** 2) ** 0.5
        ms = int(min(900, max(350, distancia * 0.9)))
        await self.pagina.evaluate("([x, y, ms]) => window.__ace.mover(x, y, ms)", [x, y, ms])
        await asyncio.sleep(ms / 1000 + 0.08)
        self.pos = (x, y)

    async def clicar(self, alvo) -> None:
        x, y, _ = await self._centro(alvo)
        await self.mover(x, y)
        await self.pagina.evaluate("([x, y]) => window.__ace.onda(x, y)", [x, y])
        await asyncio.sleep(0.12)
        await alvo.click()

    async def digitar(self, alvo, texto: str, limpar: bool = False) -> None:
        x, y, _ = await self._centro(alvo)
        await self.mover(x, y)
        await alvo.click()
        if limpar:
            await alvo.fill("")
        await alvo.press_sequentially(texto, delay=55)

    async def preencher(self, alvo, valor: str) -> None:
        """Para campos que não aceitam digitação tecla a tecla, como os de data."""
        x, y, _ = await self._centro(alvo)
        await self.mover(x, y)
        await alvo.fill(valor)

    async def passar(self, alvo) -> None:
        x, y, _ = await self._centro(alvo)
        await self.mover(x, y)
        await alvo.hover()

    async def escolher(self, alvo, valor: str | None = None, rotulo: str | None = None) -> None:
        """A lista aberta de um <select> nativo não sai na captura: o cursor vai
        até o campo e o valor muda na frente de quem assiste."""
        x, y, _ = await self._centro(alvo)
        await self.mover(x, y)
        await self.pagina.evaluate("([x, y]) => window.__ace.onda(x, y)", [x, y])
        await asyncio.sleep(0.35)
        await alvo.select_option(value=valor) if valor else await alvo.select_option(label=rotulo)

    async def destacar(self, alvo, segundos: float = 1.6) -> None:
        _, _, caixa = await self._centro(alvo)
        await self.pagina.evaluate(
            "([x, y, w, h]) => window.__ace.destaque(x, y, w, h)",
            [caixa["x"], caixa["y"], caixa["width"], caixa["height"]],
        )
        # No canto, e não no centro: ali o cursor cobriria o valor destacado.
        await self.mover(caixa["x"] + caixa["width"] - 10, caixa["y"] + caixa["height"] - 6)
        await asyncio.sleep(segundos)
        await self.pagina.evaluate("() => window.__ace.semDestaque()")

    async def cartao(self, titulo: str, sub: str = "") -> None:
        logo = "data:image/png;base64," + base64.b64encode(LOGO.read_bytes()).decode()
        await self.pagina.evaluate("([t, s, m]) => window.__ace.cartao(t, s, m)", [titulo, sub, logo])

    async def sem_cartao(self) -> None:
        await self.pagina.evaluate("() => window.__ace.semCartao()")
