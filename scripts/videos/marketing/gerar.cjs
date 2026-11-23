/**
 * Vídeos de marketing verticais (1080x1920) a partir das gravações do suporte.
 *
 *   node gerar.cjs                      todos
 *   node gerar.cjs offline es-ES        um vídeo, um idioma
 *
 * Cada vídeo: um gancho, três trechos reais do app com título e o cartão final.
 * Sai sem som (trilha silenciosa): a música entra no editor da rede, que tem a licença.
 *
 * Variáveis: VIDEOS_FINAL (pasta saida/final das gravações), LANDING_PUBLIC
 * (fontes e logo), SAIDA, CHROME e PLAYWRIGHT (módulo playwright-core).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const AQUI = __dirname;
const FINAL = process.env.VIDEOS_FINAL || path.join(AQUI, '..', 'saida', 'final');
const PUBLICO = process.env.LANDING_PUBLIC || path.join(AQUI, '..', '..', '..', 'landing', 'public');
const SAIDA = process.env.SAIDA || path.join(AQUI, 'saida');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright-core');

const W = 1080, H = 1920, FPS = 30, FUSAO = 0.3;
const CAIXA = { x: 40, largura: 1000, topo: 600 };
const roteiros = JSON.parse(fs.readFileSync(path.join(AQUI, 'roteiros.json'), 'utf8'));

const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}\n${args.join(' ')}`);
};
const url = (p) => pathToFileURL(path.resolve(p)).href;
const marcar = (texto) => texto.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

const CSS = `
@font-face{font-family:M;src:url('${url(path.join(PUBLICO, 'fonts', 'montserrat-v1.woff2'))}');font-weight:100 900}
*{margin:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:transparent;font-family:M,Arial,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
b{color:#A98BFF;font-weight:800}
.fundo{width:${W}px;height:${H}px;background:radial-gradient(1100px 760px at 50% 108%,#5A22E8 0%,rgba(90,34,232,.35) 45%,transparent 75%),radial-gradient(700px 500px at 12% -6%,rgba(109,59,255,.35),transparent 70%),#0E0420}
.logo{position:absolute;top:118px;left:0;width:${W}px;text-align:center}
.logo img{height:64px}
.marca{display:inline-flex;align-items:center;gap:18px;font-size:54px;letter-spacing:-.02em}
.marca strong{font-weight:800}.marca span{font-weight:300}
.pe{position:absolute;bottom:92px;width:100%;text-align:center;font-size:36px;font-weight:600;color:#CFC6EA;letter-spacing:.01em}
.titulo{position:absolute;left:70px;right:70px;top:250px;height:350px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:78px;line-height:1.08;font-weight:700;letter-spacing:-.025em;text-wrap:balance}
.gancho{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 80px 120px;text-align:center;text-wrap:balance}
.gancho h1{font-size:112px;line-height:1.02;font-weight:800;letter-spacing:-.035em}
.gancho p{margin-top:48px;font-size:58px;line-height:1.2;font-weight:500;color:#D9D1EF}
.cta{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 90px;text-wrap:balance}
.cta .marca{font-size:104px;margin-bottom:56px}
.cta .marca img{height:104px}
.cta p{font-size:52px;font-weight:500;line-height:1.25;color:#D9D1EF}
.cta .botao{margin-top:80px;padding:38px 66px;border-radius:26px;background:#6D3BFF;font-size:58px;font-weight:800;letter-spacing:-.01em}
.cta .site{margin-top:40px;font-size:60px;font-weight:700}
.moldura{position:absolute;inset:0;border:3px solid rgba(255,255,255,.16);border-radius:34px}
.mascara{position:absolute;inset:0;background:#fff;border-radius:34px}
`;

async function main() {
  const [soId, soIdioma] = process.argv.slice(2);
  fs.mkdirSync(SAIDA, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const nav = await chromium.launch({ executablePath: CHROME });
  const pagina = await nav.newPage({ viewport: { width: W, height: H } });
  const marca = `<span class="marca"><img src="${url(path.join(AQUI, 'simbolo.svg'))}"><span><strong>Ace</strong>Blind</span></span>`;

  const png = async (nome, html, { w = W, h = H, fundo = false } = {}) => {
    const arq = path.join(tmp, `${nome}.png`);
    await pagina.setViewportSize({ width: w, height: h });
    const doc = path.join(tmp, 'pagina.html');
    fs.writeFileSync(doc, `<!doctype html><meta charset="utf-8"><style>${CSS} html,body{width:${w}px;height:${h}px}</style>${html}`);
    await pagina.goto(url(doc));
    await pagina.evaluate(() => document.fonts.ready);
    await pagina.screenshot({ path: arq, omitBackground: !fundo });
    return arq;
  };

  for (const v of roteiros.videos) {
    if (soId && v.id !== soId) continue;
    for (const idioma of Object.keys(v.gancho)) {
      if (soIdioma && idioma !== soIdioma) continue;
      const fim = roteiros.final[idioma];
      const fundo = await png('fundo', `<div class="fundo"></div>`, { fundo: true });
      const topo = await png('topo', `<div class="logo">${marca}</div><div class="pe">aceblind.net</div>`);
      const partes = [];

      const cena = (nome, dur, camadas, clipe) => {
        // fundo + (clipe com cantos e moldura) + camadas que sobem com fade
        const saida = path.join(tmp, `${nome}.mp4`);
        const ins = ['-loop', '1', '-t', dur, '-i', fundo]; const f = []; let ult = '[0:v]'; let n = 1;
        if (clipe) {
          ins.push('-ss', clipe.inicio, '-t', dur, '-i', clipe.arquivo, '-loop', '1', '-t', dur, '-i', clipe.mascara, '-loop', '1', '-t', dur, '-i', clipe.moldura);
          const [cx, cy, cw, ch] = clipe.corte;
          f.push(`[${n}:v]fps=${FPS},crop=${cw}:${ch}:${cx}:${cy},scale=${clipe.w}:${clipe.h}:flags=lanczos,setsar=1,format=rgba[c0]`,
            `[${n + 1}:v]format=rgba,alphaextract[m]`, '[c0][m]alphamerge[c1]', `[c1][${n + 2}:v]overlay=0:0,fade=in:st=0.1:d=0.4:alpha=1[c2]`,
            `${ult}[c2]overlay=${CAIXA.x}:'${clipe.y}+40*pow(1-min(t/0.6,1),3)'[v${n}]`);
          ult = `[v${n}]`; n += 3;
        }
        camadas.forEach((c, i) => {
          ins.push('-loop', '1', '-t', dur, '-i', c.arq);
          const at = c.em || 0;
          f.push(c.parada ? `${ult}[${n}:v]overlay=0:0[v${n}]`
            : `[${n}:v]format=rgba,fade=in:st=${at}:d=0.35:alpha=1[l${i}];${ult}[l${i}]overlay=0:'46*pow(1-min(max(t-${at},0)/0.55,1),3)'[v${n}]`);
          ult = `[v${n}]`; n += 1;
        });
        f.push(`${ult}fps=${FPS},format=yuv420p[out]`);
        ffmpeg([...ins.map(String), '-filter_complex', f.join(';'), '-map', '[out]', '-t', String(dur), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', saida]);
        partes.push({ saida, dur });
      };

      const g = v.gancho[idioma];
      cena('gancho', v.duracaoDoGancho || 2.8, [
        { arq: topo, parada: true },
        { arq: await png('g1', `<div class="gancho"><h1>${marcar(g[0])}</h1><p style="visibility:hidden">${marcar(g[1])}</p></div>`), em: 0.05 },
        { arq: await png('g2', `<div class="gancho"><h1 style="visibility:hidden">${marcar(g[0])}</h1><p>${marcar(g[1])}</p></div>`), em: 0.9 },
      ]);

      for (const [i, c] of v.cenas.entries()) {
        const t = c.trecho[idioma] ?? c.trecho['*'];
        const corte = c.corte;
        const w = CAIXA.largura, h = Math.round((w * corte[3]) / corte[2] / 2) * 2;
        const y = Math.round(CAIXA.topo + Math.max(0, (960 - h) / 2));
        cena(`cena${i}`, c.duracao, [
          { arq: topo, parada: true },
          { arq: await png(`t${i}`, `<div class="titulo"><span>${marcar(c.titulo[idioma])}</span></div>`), em: 0.1 },
        ], {
          arquivo: path.join(FINAL, idioma, `${c.video}.mp4`), inicio: t, corte, w, h, y,
          mascara: await png(`m${i}`, '<div class="mascara"></div>', { w, h }),
          moldura: await png(`b${i}`, '<div class="moldura"></div>', { w, h }),
        });
      }

      cena('final', 3.2, [
        { arq: await png('f1', `<div class="cta">${marca}<p>${marcar(fim.frase)}</p><div class="botao" style="visibility:hidden">${fim.botao}</div><div class="site" style="visibility:hidden">aceblind.net</div></div>`), em: 0.05 },
        { arq: await png('f2', `<div class="cta"><span style="visibility:hidden">${marca}</span><p style="visibility:hidden">${marcar(fim.frase)}</p><div class="botao">${fim.botao}</div><div class="site">aceblind.net</div></div>`), em: 0.55 },
      ]);

      // junta com fusão
      const f = []; let ult = '[0:v]'; let pos = partes[0].dur;
      partes.slice(1).forEach((p, i) => {
        pos -= FUSAO;
        f.push(`${ult}[${i + 1}:v]xfade=transition=fade:duration=${FUSAO}:offset=${pos.toFixed(3)}[x${i}]`);
        ult = `[x${i}]`; pos += p.dur;
      });
      const nome = `${v.id}-${idioma}.mp4`;
      ffmpeg([...partes.flatMap((p) => ['-i', p.saida]), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-filter_complex', f.join(';'), '-map', ult, '-map', `${partes.length}:a`, '-shortest',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(SAIDA, nome)]);
      console.log(nome, `${pos.toFixed(1)}s`);
    }
  }
  await nav.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
main().catch((e) => { console.error(e); process.exit(1); });
