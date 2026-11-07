/* ============================================================================
   IMAGEM DE COMPARTILHAMENTO — public/og-pt.png, og-es.png, og-en.png (1200×630)
   ============================================================================
   Roda à mão, com o Chrome instalado, e as imagens geradas são versionadas: o
   build do Docker não tem navegador, e a imagem muda raramente.

     node scripts/gerar-og.mjs
     CHROME="/caminho/do/chrome" node scripts/gerar-og.mjs

   O nginx serve imagem com cache de 30 dias e `immutable`. Mudou o texto? Troque
   também o nome do arquivo (og-pt-v2.png) e o IDIOMAS de build.mjs, ou quem já
   baixou a antiga continua vendo a antiga.
   ============================================================================ */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(AQUI, '..', 'public');

const TEXTOS = {
  pt: {
    titulo: 'Sistema de gestão para clubes de poker',
    italico: 'que não para quando a internet cai.',
    rodape: 'Torneio, caixa e ranking numa ferramenta só',
  },
  es: {
    titulo: 'Sistema de gestión para clubes de póker',
    italico: 'que no se detiene cuando se cae internet.',
    rodape: 'Torneo, caja y ranking en una sola herramienta',
  },
  en: {
    titulo: 'Poker club management software',
    italico: 'that keeps running when the internet drops.',
    rodape: 'Tournaments, cash desk and rankings in one tool',
  },
};

function acharChrome(){
  const candidatos = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const achado = candidatos.find(c => existsSync(c));
  if(!achado) throw new Error('Chrome não encontrado: defina a variável CHROME');
  return achado;
}

function fonteEmBase64(arquivo){
  return readFileSync(join(PUBLICO, 'fonts', arquivo)).toString('base64');
}

function pagina({ titulo, italico, rodape }){
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:M;src:url(data:font/woff2;base64,${fonteEmBase64('montserrat-v1.woff2')}) format('woff2');font-weight:100 900;font-style:normal}
@font-face{font-family:M;src:url(data:font/woff2;base64,${fonteEmBase64('montserrat-italic-v1.woff2')}) format('woff2');font-weight:100 900;font-style:italic}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px;overflow:hidden}
body{
  font-family:M,Arial,sans-serif;color:#fff;padding:64px 72px;
  background:radial-gradient(900px 560px at 88% 30%,rgba(109,59,255,.55),transparent 62%),
             radial-gradient(700px 480px at 4% 4%,rgba(43,10,107,.9),transparent 68%),#14052E;
  display:flex;flex-direction:column;justify-content:space-between;
}
.marca{display:flex;align-items:center;gap:14px;font-size:34px;letter-spacing:-.02em}
.marca svg{width:38px;height:38px}
.marca b{font-weight:700}.marca span{font-weight:300}
h1{font-size:66px;font-weight:400;line-height:1.08;letter-spacing:-.03em;max-width:1010px}
h1 i{display:block;font-weight:400;color:#B79CFF}
p{font-size:26px;color:#C9C2DE;letter-spacing:-.01em}
</style></head><body>
<div class="marca">
  <svg viewBox="0 0 40 40"><path d="M20 3 L36 37 H28.5 L20 18 L11.5 37 H4 Z" fill="#fff"/><path d="M20 24 L24 30 L20 36 L16 30 Z" fill="#fff"/></svg>
  <div><b>Ace</b><span>Blind</span></div>
</div>
<h1>${titulo}<i>${italico}</i></h1>
<p>${rodape}</p>
</body></html>`;
}

const chrome = acharChrome();
const pasta = mkdtempSync(join(tmpdir(), 'aceblind-og-'));

for(const [idioma, textos] of Object.entries(TEXTOS)){
  const html = join(pasta, `${idioma}.html`);
  writeFileSync(html, pagina(textos));
  const saida = join(PUBLICO, `og-${idioma}.png`);
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1200,630', '--virtual-time-budget=2000',
    `--user-data-dir=${join(pasta, 'perfil')}`,
    `--screenshot=${saida}`, pathToFileURL(html).href,
  ], { stdio: 'ignore' });
  console.log('  ✓', saida);
}

rmSync(pasta, { recursive: true, force: true });
