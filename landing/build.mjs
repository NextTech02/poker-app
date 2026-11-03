/* ============================================================================
   BUILD DA LANDING — uma página HTML pronta por idioma
   ============================================================================
   Entrada:  index.html (o português, que é a fonte do markup)
             i18n.js    (inglês e espanhol)
             public/    (robots.txt, 404.html, og.png, fontes…)
   Saída:    dist/index.html      português   → aceblind.net/
             dist/es/index.html   espanhol    → aceblind.net/es/
             dist/en/index.html   inglês      → aceblind.net/en/
             dist/sitemap.xml     as três URLs, ligadas por hreflang
             + o conteúdo de public/

   POR QUE EXISTE
   Antes, as três línguas viviam na mesma URL e o JavaScript trocava o texto
   no navegador. Para o Google isso era uma página só: o canonical apontava
   para a home, o idioma declarado era pt-BR, e o robô — que renderiza com o
   navegador em inglês — podia até ler a home EM INGLÊS. Espanhol e inglês
   nunca entravam na busca.

   Agora cada idioma é um arquivo HTML com o texto já traduzido, título,
   descrição, canonical e hreflang próprios, e os dados estruturados (empresa,
   software, FAQ) montados a partir do próprio texto da página. O que o robô lê
   é o que a pessoa lê, sem depender de JavaScript.

   Roda dentro do Dockerfile. Para conferir localmente:
     npm install && npm run build      →  abre dist/ com qualquer servidor
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIST = join(AQUI, 'dist');
const SITE = 'https://aceblind.net';

/* A ordem importa só para o sitemap e para o log. `codigo` é a chave dos
   dicionários em i18n.js; `lang` é o que vai no <html lang> e no hreflang. */
const IDIOMAS = [
  { codigo: 'pt-BR', lang: 'pt-BR', caminho: '/',    og: 'pt_BR', inLanguage: 'pt-BR' },
  { codigo: 'es-ES', lang: 'es',    caminho: '/es/', og: 'es_LA', inLanguage: 'es'    },
  { codigo: 'en-US', lang: 'en',    caminho: '/en/', og: 'en_US', inLanguage: 'en'    },
];

/* Textos que o JavaScript escreve na tela depois da carga (animação da TV,
   mensagens do formulário). Só estes vão para a página, num objeto pequeno —
   o i18n.js inteiro (~27 KB) não precisa mais ser baixado por ninguém. */
const CHAVES_DE_RUNTIME = [
  'tv.semConexao', 'tv.sincronizado', 'tv.msgOff', 'tv.msgSync', 'tv.msgReduzido',
  'form.erroCampos', 'form.erroEmail', 'form.erroEnvio', 'form.enviando',
];

/* ---------------------------------------------------------------------------- */

function carregarTraducoes(){
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(AQUI, 'i18n.js'), 'utf8'), sandbox, { filename: 'i18n.js' });
  const { ACEBLIND_I18N: dic, ACEBLIND_META: meta } = sandbox.window;
  if(!dic || !meta) throw new Error('i18n.js não definiu ACEBLIND_I18N e ACEBLIND_META');
  return { dic, meta };
}

/* O número do WhatsApp continua configurado num lugar só: o bloco
   CONFIGURAÇÃO DA PÁGINA, no fim do index.html. */
function numeroWhatsApp(html){
  const m = html.match(/window\.ACEBLIND_WHATSAPP\s*=\s*'(\d*)'/);
  return m ? m[1] : '';
}

function url(caminho){ return SITE + caminho; }

/* JSON dentro de <script>: `<` escapado para que um "</script>" num texto do
   FAQ nunca feche a tag antes da hora. */
function jsonEmScript(obj){
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function texto($, el){ return $(el).text().replace(/\s+/g, ' ').trim(); }

/* "$49" → { valor: '49', moeda: 'USD' }. Quando o preço em reais entrar na
   página, "R$ 249" já sai como BRL nos dados estruturados. */
function lerPreco(bruto){
  if(!bruto) return null;
  const s = bruto.replace(/\s/g, '');
  const moedas = [['R$', 'BRL'], ['COP$', 'COP'], ['S/', 'PEN'], ['US$', 'USD'], ['$', 'USD']];
  const achada = moedas.find(([simbolo]) => s.startsWith(simbolo));
  const numero = s.replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  if(!achada || numero === '') return null;
  return { valor: String(Number(numero)), moeda: achada[1] };
}

function dadosEstruturados($, idioma, meta, whatsapp){
  const pagina = url(idioma.caminho);

  const ofertas = [];
  $('.plan').each((_, plano) => {
    const nome = texto($, $(plano).find('h3').first());
    const b = $(plano).find('.plan__price b').first();
    const preco = lerPreco(b.attr('data-mensal') || b.text());
    if(nome && preco){
      ofertas.push({ '@type': 'Offer', name: nome, price: preco.valor, priceCurrency: preco.moeda, url: pagina + '#planos' });
    }
  });

  const perguntas = [];
  $('.faq__item').each((_, item) => {
    const q = texto($, $(item).find('.faq__q'));
    const a = texto($, $(item).find('.faq__a'));
    if(q && a) perguntas.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } });
  });

  const organizacao = {
    '@type': 'Organization',
    '@id': SITE + '/#organizacao',
    name: 'AceBlind',
    url: SITE + '/',
  };
  if(whatsapp){
    organizacao.contactPoint = {
      '@type': 'ContactPoint',
      telephone: '+' + whatsapp,
      contactType: 'sales',
      availableLanguage: ['Portuguese', 'Spanish', 'English'],
    };
  }

  const grafo = [
    organizacao,
    {
      '@type': 'WebSite',
      '@id': SITE + '/#site',
      name: 'AceBlind',
      url: SITE + '/',
      publisher: { '@id': SITE + '/#organizacao' },
      inLanguage: IDIOMAS.map(i => i.inLanguage),
    },
    {
      '@type': 'SoftwareApplication',
      name: 'AceBlind',
      url: pagina,
      description: meta.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: idioma.inLanguage,
      publisher: { '@id': SITE + '/#organizacao' },
      ...(ofertas.length ? { offers: ofertas } : {}),
    },
  ];
  if(perguntas.length){
    grafo.push({ '@type': 'FAQPage', url: pagina, inLanguage: idioma.inLanguage, mainEntity: perguntas });
  }
  return { '@context': 'https://schema.org', '@graph': grafo };
}

function gerar(fonte, idioma, { dic, meta: metas }, whatsapp){
  const $ = cheerio.load(fonte);
  const d = idioma.codigo === 'pt-BR' ? null : (dic[idioma.codigo] || {});
  const meta = metas[idioma.codigo];
  if(!meta) throw new Error('ACEBLIND_META sem a entrada ' + idioma.codigo);
  const faltando = new Set();

  /* 1. Texto. O português é o próprio HTML; os outros vêm do dicionário.
     Chave faltando fica em português — como era no navegador — e o build
     avisa no log, para ninguém publicar uma página meio traduzida sem saber. */
  if(d){
    $('[data-i18n]').each((_, el) => {
      const k = $(el).attr('data-i18n');
      if(d[k] == null) faltando.add(k); else $(el).html(d[k]);
    });
    $('[data-i18n-ph]').each((_, el) => {
      const k = $(el).attr('data-i18n-ph');
      if(d[k] == null) faltando.add(k); else $(el).attr('placeholder', d[k]);
    });
    $('[data-i18n-aria]').each((_, el) => {
      const k = $(el).attr('data-i18n-aria');
      if(d[k] == null) faltando.add(k); else $(el).attr('aria-label', d[k]);
    });
  }

  /* 2. Cabeça da página: idioma, título, descrição, canonical, Open Graph. */
  $('html').attr('lang', idioma.lang);
  $('title').text(meta.title);
  $('meta[name="description"]').attr('content', meta.description);
  $('link[rel="canonical"]').attr('href', url(idioma.caminho));
  $('meta[property="og:url"]').attr('content', url(idioma.caminho));
  $('meta[property="og:title"]').attr('content', meta.ogTitle || meta.title);
  $('meta[property="og:description"]').attr('content', meta.ogDescription || meta.description);
  $('meta[property="og:locale"]').attr('content', idioma.og);
  $('meta[property="og:locale:alternate"]').remove();
  const ogLocale = $('meta[property="og:locale"]');
  IDIOMAS.filter(i => i !== idioma).reverse().forEach(i => {
    ogLocale.after(`\n<meta property="og:locale:alternate" content="${i.og}">`);
  });

  /* hreflang: as três versões se apontam, mais o x-default (português, que é
     o mercado principal). Reescritas aqui para nunca divergirem de IDIOMAS. */
  $('link[rel="alternate"][hreflang]').remove();
  const alternativos = IDIOMAS.map(i => `<link rel="alternate" hreflang="${i.lang}" href="${url(i.caminho)}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${url('/')}">`);
  $('link[rel="canonical"]').after('\n' + alternativos.join('\n'));

  /* 3. Seletor de idioma: links de verdade, que o Google segue. */
  $('#langMenu a[data-lang]').each((_, a) => {
    if($(a).attr('data-lang') === idioma.codigo) $(a).attr('aria-current', 'page');
    else $(a).removeAttr('aria-current');
  });
  $('#langAtual').text(idioma.lang.slice(0, 2).toUpperCase());

  /* 4. WhatsApp com destino real no HTML, já com a mensagem no idioma da
     página. Antes o href era "#demo"/"#" e só virava wa.me pelo JavaScript. */
  if(whatsapp){
    const href = 'https://wa.me/' + whatsapp + '?text=' + encodeURIComponent(meta.whatsapp || '');
    $('.wa-link').attr('href', href).attr('target', '_blank').attr('rel', 'noopener');
  }

  /* 5. Os poucos textos que o JavaScript ainda escreve depois da carga. */
  const runtime = {};
  if(d){
    CHAVES_DE_RUNTIME.forEach(k => { if(d[k] != null) runtime[k] = d[k]; else faltando.add(k); });
  }
  runtime['wa.texto'] = meta.whatsapp || '';
  const alvo = $('script#textos-runtime');
  if(!alvo.length) throw new Error('index.html sem <script id="textos-runtime">');
  alvo.text(`window.ACEBLIND_T = ${jsonEmScript(runtime)};`);

  /* 6. Dados estruturados, montados do texto já traduzido. */
  $('head').append(`<script type="application/ld+json">${jsonEmScript(dadosEstruturados($, idioma, meta, whatsapp))}</script>\n`);

  if(faltando.size) console.warn(`  ! ${idioma.codigo}: ${faltando.size} chave(s) sem tradução, ficaram em português:`, [...faltando].join(', '));
  /* Os <link> removidos e recolocados deixam linhas vazias no lugar. */
  return $.html().replace(/\n{3,}/g, '\n\n');
}

function sitemap(){
  const alternativos = IDIOMAS.map(i => `    <xhtml:link rel="alternate" hreflang="${i.lang}" href="${url(i.caminho)}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${url('/')}"/>`)
    .join('\n');
  const urls = IDIOMAS.map(i => `  <url>\n    <loc>${url(i.caminho)}</loc>\n${alternativos}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

/* ---------------------------------------------------------------------------- */

const fonte = readFileSync(join(AQUI, 'index.html'), 'utf8');
const traducoes = carregarTraducoes();
const whatsapp = numeroWhatsApp(fonte);
if(!whatsapp) console.warn('  ! ACEBLIND_WHATSAPP vazio: os botões de WhatsApp vão levar ao formulário');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
if(existsSync(join(AQUI, 'public'))) cpSync(join(AQUI, 'public'), DIST, { recursive: true });

for(const idioma of IDIOMAS){
  const destino = join(DIST, idioma.caminho, 'index.html');
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, gerar(fonte, idioma, traducoes, whatsapp));
  console.log(`  ✓ ${idioma.codigo.padEnd(5)} → dist${idioma.caminho}index.html`);
}
writeFileSync(join(DIST, 'sitemap.xml'), sitemap());
console.log('  ✓ sitemap.xml com', IDIOMAS.length, 'URLs');
