/* Confere o site gerado em dist/. Rode depois do build: `npm run build && npm test`.
   Sem dist/, os testes são pulados.

   São os erros que não aparecem na tela e custam posição na busca: hreflang sem
   volta, canonical apontando para outra página, JSON-LD inválido, página que
   nenhum link alcança. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SITE = 'https://aceblind.net';
const pular = { skip: !existsSync(join(DIST, 'index.html')) };

function htmls(pasta){
  return readdirSync(pasta).flatMap(nome => {
    const caminho = join(pasta, nome);
    if(statSync(caminho).isDirectory()) return htmls(caminho);
    return nome === 'index.html' ? [caminho] : [];
  });
}

function carregar(){
  const paginas = new Map();
  for(const arquivo of htmls(DIST)){
    const rel = relative(DIST, arquivo).split(sep).join('/').replace(/index\.html$/, '');
    paginas.set(`${SITE}/${rel}`, cheerio.load(readFileSync(arquivo, 'utf8')));
  }
  return paginas;
}

const paginas = pular.skip ? new Map() : carregar();

test('canonical de cada página aponta para ela mesma', pular, () => {
  for(const [url, $] of paginas) assert.equal($('link[rel="canonical"]').attr('href'), url);
});

test('cada página tem título, descrição e H1 próprios', pular, () => {
  const titulos = new Set(), descricoes = new Set();
  for(const [url, $] of paginas){
    const titulo = $('title').text(), descricao = $('meta[name="description"]').attr('content');
    assert.ok(titulo && descricao, url);
    assert.ok(!titulos.has(titulo), `título repetido em ${url}`);
    assert.ok(!descricoes.has(descricao), `descrição repetida em ${url}`);
    titulos.add(titulo);
    descricoes.add(descricao);
    assert.equal($('h1').length, 1, url);
  }
});

test('o idioma declarado bate com a pasta', pular, () => {
  for(const [url, $] of paginas){
    const esperado = url.startsWith(`${SITE}/es/`) ? 'es' : url.startsWith(`${SITE}/en/`) ? 'en' : 'pt-BR';
    assert.equal($('html').attr('lang'), esperado, url);
  }
});

test('hreflang é recíproco e inclui a própria página', pular, () => {
  for(const [url, $] of paginas){
    const alternativas = $('link[rel="alternate"][hreflang]').toArray().map(l => ({ lang: $(l).attr('hreflang'), href: $(l).attr('href') }));
    if(!alternativas.length) continue;
    assert.ok(alternativas.some(a => a.href === url), `${url} não aponta para si`);
    assert.ok(alternativas.some(a => a.lang === 'x-default'), `${url} sem x-default`);
    for(const { lang, href } of alternativas){
      if(lang === 'x-default') continue;
      const $alvo = paginas.get(href);
      assert.ok($alvo, `${url} aponta para ${href}, que não existe`);
      assert.ok($alvo(`link[rel="alternate"][href="${url}"]`).length, `${href} não aponta de volta para ${url}`);
    }
  }
});

test('JSON-LD é válido, e toda página tem migalhas, menos a home', pular, () => {
  for(const [url, $] of paginas){
    const blocos = $('script[type="application/ld+json"]').toArray();
    assert.equal(blocos.length, 1, url);
    const { '@graph': grafo } = JSON.parse($(blocos[0]).text());
    const tipos = grafo.map(n => n['@type']);
    assert.ok(tipos.includes('Organization'), url);
    const home = /^https:\/\/aceblind\.net\/((es|en)\/)?$/.test(url);
    assert.equal(tipos.includes('BreadcrumbList'), !home, url);
    if(!home){
      const { itemListElement: itens } = grafo.find(n => n['@type'] === 'BreadcrumbList');
      assert.equal(itens.at(-1).item, url, `última migalha de ${url}`);
      for(const item of itens) assert.ok(paginas.has(item.item), `migalha quebrada em ${url}: ${item.item}`);
    }
  }
});

test('nenhuma afirmação retirada voltou ao site', pular, () => {
  const proibidas = [/roda localmente na máquina/i, /corre localmente/i, /runs locally/i, /check-in/i, /único sistema/i, /only system/i, /único sistema de su/i, /numa só visão/i, /economize 30/i];
  for(const [url, $] of paginas){
    const clone = $('main, footer').text();
    for(const frase of proibidas) assert.ok(!frase.test(clone), `${frase} em ${url}`);
  }
});

/* Espanhol neutro para a LatAm: nada de voseo, nem de "planilla", que no Peru é
   folha de pagamento. "Sangría" só retorna vinho na busca, e "casa de póker"
   só retorna cidade brasileira: os termos são "retiro de caja" e "club o sala". */
test('espanhol neutro nas páginas /es/', pular, () => {
  const fora = /(?<![\p{L}])(sos|vos|querés|podés|tenés|preferís|abrís|elegís|pasás|usás|cargás|empezá|escribinos|probá|ahorrá|pedí|creá|corré|hablá|mirá|acá|planilla|planillas|sangría|sangrías|casa de póker|casas de póker)(?![\p{L}])/iu;
  for(const [url, $] of paginas){
    if(!url.startsWith(`${SITE}/es/`)) continue;
    const achado = $('body').clone().find('script,style').remove().end().text().match(fora);
    assert.equal(achado, null, `${achado && achado[0]} em ${url}`);
  }
});

test('sitemap lista exatamente as páginas do site', pular, () => {
  const xml = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).sort();
  assert.deepEqual(urls, [...paginas.keys()].sort());
});

test('nenhuma página fica órfã, e a home alcança todas', pular, () => {
  const alcancadas = new Set();
  const fila = [`${SITE}/`, `${SITE}/es/`, `${SITE}/en/`];
  while(fila.length){
    const url = fila.pop();
    if(alcancadas.has(url)) continue;
    alcancadas.add(url);
    const $ = paginas.get(url);
    if(!$) continue;
    $('a[href^="/"]').each((_, a) => {
      const destino = SITE + $(a).attr('href').split('#')[0].split('?')[0];
      if(paginas.has(destino)) fila.push(destino);
    });
  }
  for(const url of paginas.keys()) assert.ok(alcancadas.has(url), `${url} não recebe link`);
});

test('toda página interna leva a uma conversão', pular, () => {
  for(const [url, $] of paginas){
    assert.ok($('#demo form#form').length, `${url} sem formulário`);
    assert.ok($('a.wa[href^="https://wa.me/"]').length, `${url} sem WhatsApp`);
  }
});

/* Acima de 60 caracteres, a API recusa o lead inteiro (backend/app/routers/leads.py).
   Este teste só garante que o corte continua no código, em todas as páginas. */
test('o envio do lead corta a origem em 60 caracteres', pular, () => {
  for(const [url, $] of paginas){
    assert.match($('script#js-comum').text(), /\.slice\(0, 60\)/, url);
  }
});
