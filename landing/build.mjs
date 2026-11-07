/* ============================================================================
   BUILD DA LANDING — o site inteiro, uma pasta com index.html por página
   ============================================================================
   Entrada:  index.html            a home em português: fonte do markup, do CSS e
                                   do JavaScript comum a todas as páginas
             i18n.js               a home em inglês e espanhol
             conteudo/<pt|es|en>/  uma página interna por arquivo .html
             conteudo/rotulos.mjs  os textos da moldura das páginas internas
             conteudo/conteudo.css o CSS que só as páginas internas usam
             ferramentas/          o JavaScript das ferramentas grátis
             public/               robots.txt, 404.html, imagens, fontes
   Saída:    dist/                 o site pronto, mais o sitemap.xml

   POR QUE EXISTE
   O Google lê HTML. Cada idioma e cada assunto precisa ser uma URL com o texto
   já escrito, título, descrição, canonical, hreflang e dados estruturados
   próprios — o que o robô lê é o que a pessoa lê, sem depender de JavaScript.
   Uma página única em três idiomas só compete por um punhado de buscas; as
   páginas internas são o que dá ao site assunto para aparecer em mais delas.

   O build FALHA, de propósito, em link interno quebrado, slug repetido, título
   repetido e campo obrigatório faltando: é melhor o deploy parar do que o erro
   ir ao ar sem ninguém ver. Título e descrição longos demais só avisam.

   Roda dentro do Dockerfile. Para conferir localmente:
     npm install && npm run build      →  abre dist/ com qualquer servidor
   ============================================================================ */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as cheerio from 'cheerio';
import { ROTULOS } from './conteudo/rotulos.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DIST = join(AQUI, 'dist');
const SITE = 'https://aceblind.net';
const ID_ORGANIZACAO = SITE + '/#organizacao';
const ID_SITE = SITE + '/#site';
const ID_SOFTWARE = SITE + '/#software';

/* A ordem importa só para o sitemap e para o log. `codigo` é a chave dos
   dicionários em i18n.js; `lang` é o que vai no <html lang> e no hreflang;
   `pasta` é o nome da pasta em conteudo/. */
const IDIOMAS = [
  { codigo: 'pt-BR', lang: 'pt-BR', pasta: 'pt', caminho: '/',    og: 'pt_BR', inLanguage: 'pt-BR', imagem: '/og-pt.png' },
  { codigo: 'es-ES', lang: 'es',    pasta: 'es', caminho: '/es/', og: 'es_LA', inLanguage: 'es',    imagem: '/og-es.png' },
  { codigo: 'en-US', lang: 'en',    pasta: 'en', caminho: '/en/', og: 'en_US', inLanguage: 'en',    imagem: '/og-en.png' },
];

/* Textos que o JavaScript escreve na tela depois da carga (animação da TV,
   mensagens do formulário). Só estes vão para a página, num objeto pequeno —
   o i18n.js inteiro (~27 KB) não precisa mais ser baixado por ninguém. */
const CHAVES_DE_RUNTIME = [
  'tv.semConexao', 'tv.sincronizado', 'tv.msgOff', 'tv.msgSync', 'tv.msgReduzido',
  'form.erroCampos', 'form.erroEmail', 'form.erroEnvio', 'form.enviando',
];

/* As seções do site, na ordem do rodapé. `hub` é o id da página que lista as
   demais daquela seção; sem hub, a migalha vai direto da home para a página. */
const SECOES = {
  produto:       { rotulo: 'produto' },
  ferramentas:   { rotulo: 'ferramentas', hub: 'ferramentas' },
  guias:         { rotulo: 'guias', hub: 'guias' },
  institucional: { rotulo: 'institucional' },
};

const CAMPOS_OBRIGATORIOS = ['id', 'secao', 'slug', 'titulo', 'descricao', 'h1', 'rotulo', 'resumo', 'atualizado'];

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

function escapar(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

/* ---- páginas internas ------------------------------------------------------- */

/* Cada arquivo começa com um bloco `chave: valor` entre linhas `---`; o resto é
   o HTML do corpo. O mesmo `id` em pastas diferentes é a mesma página traduzida:
   é isso que liga o hreflang. Cada idioma tem o seu `slug`, porque quem busca em
   espanhol digita "reloj de póker", e não "timer de poker". */
function lerPaginas(){
  const paginas = [];
  for(const idioma of IDIOMAS){
    const pasta = join(AQUI, 'conteudo', idioma.pasta);
    if(!existsSync(pasta)) continue;
    for(const nome of readdirSync(pasta).filter(n => n.endsWith('.html')).sort()){
      const arquivo = `conteudo/${idioma.pasta}/${nome}`;
      const m = readFileSync(join(pasta, nome), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if(!m) throw new Error(`${arquivo}: falta o bloco --- do início`);
      const campos = {};
      for(const linha of m[1].split(/\r?\n/)){
        const i = linha.indexOf(':');
        if(i > 0) campos[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
      }
      for(const c of CAMPOS_OBRIGATORIOS){
        if(!campos[c]) throw new Error(`${arquivo}: falta o campo "${c}"`);
      }
      if(!SECOES[campos.secao]) throw new Error(`${arquivo}: seção desconhecida "${campos.secao}"`);
      paginas.push({
        ...campos,
        ordem: Number(campos.ordem || 100),
        relacionados: (campos.relacionados || '').split(',').map(s => s.trim()).filter(Boolean),
        idioma, arquivo, corpo: m[2],
        caminho: idioma.caminho + campos.slug.replace(/^\/|\/$/g, '') + '/',
      });
    }
  }
  return paginas;
}

function conferirPaginas(paginas){
  const unico = (chave, descricao) => {
    const vistos = new Map();
    for(const p of paginas){
      const k = chave(p);
      if(vistos.has(k)) throw new Error(`${descricao} repetido: ${p.arquivo} e ${vistos.get(k)}`);
      vistos.set(k, p.arquivo);
    }
  };
  unico(p => p.caminho, 'endereço');
  unico(p => p.idioma.codigo + '|' + p.id, 'id');
  unico(p => p.titulo, 'título');
  unico(p => p.descricao, 'descrição');

  for(const p of paginas){
    if(p.titulo.length > 62) console.warn(`  ! ${p.arquivo}: título com ${p.titulo.length} caracteres (o Google corta perto de 60)`);
    if(p.descricao.length > 160) console.warn(`  ! ${p.arquivo}: descrição com ${p.descricao.length} caracteres (o Google corta perto de 155)`);
    for(const id of p.relacionados){
      if(!paginas.some(o => o.id === id && o.idioma === p.idioma)) throw new Error(`${p.arquivo}: relacionado "${id}" não existe em ${p.idioma.pasta}`);
    }
  }
}

function versoes(paginas, pagina){ return paginas.filter(p => p.id === pagina.id); }

function naOrdem(lista){
  return [...lista].sort((a, b) => a.ordem - b.ordem || a.rotulo.localeCompare(b.rotulo));
}

/* ---- dados estruturados ------------------------------------------------------ */

function noOrganizacao(whatsapp){
  const organizacao = {
    '@type': 'Organization',
    '@id': ID_ORGANIZACAO,
    name: 'AceBlind',
    url: SITE + '/',
    logo: { '@type': 'ImageObject', url: url('/logo.png'), width: 512, height: 512 },
  };
  if(whatsapp){
    organizacao.contactPoint = {
      '@type': 'ContactPoint',
      telephone: '+' + whatsapp,
      contactType: 'sales',
      availableLanguage: ['Portuguese', 'Spanish', 'English'],
    };
  }
  return organizacao;
}

function noSite(){
  return {
    '@type': 'WebSite',
    '@id': ID_SITE,
    name: 'AceBlind',
    url: SITE + '/',
    publisher: { '@id': ID_ORGANIZACAO },
    inLanguage: IDIOMAS.map(i => i.inLanguage),
  };
}

function dadosDaHome($, idioma, meta, whatsapp){
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

  const grafo = [
    noOrganizacao(whatsapp),
    noSite(),
    {
      '@type': 'SoftwareApplication',
      '@id': ID_SOFTWARE,
      name: 'AceBlind',
      url: pagina,
      description: meta.description,
      image: url(idioma.imagem),
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: idioma.inLanguage,
      publisher: { '@id': ID_ORGANIZACAO },
      ...(ofertas.length ? { offers: ofertas } : {}),
    },
  ];
  if(perguntas.length){
    grafo.push({ '@type': 'FAQPage', url: pagina, inLanguage: idioma.inLanguage, mainEntity: perguntas });
  }
  return { '@context': 'https://schema.org', '@graph': grafo };
}

function dadosDaInterna($, pagina, migalhas, whatsapp){
  const { idioma } = pagina;
  const endereco = url(pagina.caminho);
  const comum = {
    url: endereco,
    name: pagina.titulo,
    description: pagina.descricao,
    inLanguage: idioma.inLanguage,
    isPartOf: { '@id': ID_SITE },
    dateModified: pagina.atualizado,
    breadcrumb: { '@id': endereco + '#migalhas' },
  };

  const grafo = [noOrganizacao(whatsapp), noSite()];

  if(pagina.secao === 'guias' && pagina.slug !== SECOES.guias.hub && !pagina.hub){
    grafo.push({
      '@type': 'Article',
      '@id': endereco + '#pagina',
      ...comum,
      headline: pagina.h1,
      image: url(idioma.imagem),
      datePublished: pagina.publicado || pagina.atualizado,
      author: { '@id': ID_ORGANIZACAO },
      publisher: { '@id': ID_ORGANIZACAO },
      mainEntityOfPage: endereco,
    });
  } else if(pagina.ferramenta){
    grafo.push({
      '@type': 'WebApplication',
      '@id': endereco + '#pagina',
      ...comum,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Web',
      browserRequirements: 'Requires JavaScript',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': ID_ORGANIZACAO },
    });
  } else {
    grafo.push({
      '@type': pagina.hub ? 'CollectionPage' : 'WebPage',
      '@id': endereco + '#pagina',
      ...comum,
      ...(pagina.secao === 'produto' ? { about: { '@id': ID_SOFTWARE } } : {}),
    });
  }

  grafo.push({
    '@type': 'BreadcrumbList',
    '@id': endereco + '#migalhas',
    itemListElement: migalhas.map((m, i) => ({
      '@type': 'ListItem', position: i + 1, name: m.nome, item: url(m.caminho),
    })),
  });

  const perguntas = [];
  $('details.pergunta').each((_, item) => {
    const q = texto($, $(item).find('summary'));
    const a = texto($, $(item).find('div').first());
    if(q && a) perguntas.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } });
  });
  if(perguntas.length){
    grafo.push({ '@type': 'FAQPage', url: endereco, inLanguage: idioma.inLanguage, mainEntity: perguntas });
  }
  return { '@context': 'https://schema.org', '@graph': grafo };
}

/* ---- o que home e páginas internas têm em comum ------------------------------ */

/* Aplica o idioma ao markup do index.html. */
function traduzir(fonte, idioma, { dic }, faltando){
  const $ = cheerio.load(fonte);
  const d = idioma.codigo === 'pt-BR' ? null : (dic[idioma.codigo] || {});

  /* O português é o próprio HTML; os outros vêm do dicionário. Chave faltando
     fica em português — como era no navegador — e o build avisa no log, para
     ninguém publicar uma página meio traduzida sem saber. */
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
  return { $, d };
}

/* Cabeça da página: idioma, título, descrição, canonical, hreflang, Open Graph. */
function aplicarCabeca($, idioma, { titulo, descricao, ogTitulo, ogDescricao, caminho, alternativos }){
  $('html').attr('lang', idioma.lang);
  $('title').text(titulo);
  $('meta[name="description"]').attr('content', descricao);
  $('link[rel="canonical"]').attr('href', url(caminho));
  $('meta[property="og:url"]').attr('content', url(caminho));
  $('meta[property="og:title"]').attr('content', ogTitulo || titulo);
  $('meta[property="og:description"]').attr('content', ogDescricao || descricao);
  $('meta[property="og:image"]').attr('content', url(idioma.imagem));
  $('meta[property="og:image:alt"]').attr('content', ogTitulo || titulo);
  $('meta[property="og:locale"]').attr('content', idioma.og);
  $('meta[property="og:locale:alternate"]').remove();
  const ogLocale = $('meta[property="og:locale"]');
  alternativos.filter(a => a.idioma !== idioma).reverse().forEach(a => {
    ogLocale.after(`\n<meta property="og:locale:alternate" content="${a.idioma.og}">`);
  });

  /* hreflang: cada versão aponta para todas, inclusive para si mesma, mais o
     x-default (português, que é o mercado principal). Página sem tradução não
     declara nenhum: hreflang apontando para uma URL que não aponta de volta é
     ignorado pelo Google. */
  $('link[rel="alternate"][hreflang]').remove();
  if(alternativos.length > 1){
    const padrao = alternativos.find(a => a.idioma.codigo === 'pt-BR') || alternativos[0];
    const linhas = alternativos.map(a => `<link rel="alternate" hreflang="${a.idioma.lang}" href="${url(a.caminho)}">`)
      .concat(`<link rel="alternate" hreflang="x-default" href="${url(padrao.caminho)}">`);
    $('link[rel="canonical"]').after('\n' + linhas.join('\n'));
  }
}

/* Seletor de idioma: links de verdade, que o Google segue. Sem tradução daquela
   página, o link leva para a home do idioma. */
function aplicarSeletor($, idioma, alternativos){
  $('#langMenu a[data-lang]').each((_, a) => {
    const codigo = $(a).attr('data-lang');
    const versao = alternativos.find(v => v.idioma.codigo === codigo);
    const destino = IDIOMAS.find(i => i.codigo === codigo);
    $(a).attr('href', versao ? versao.caminho : destino.caminho);
    if(codigo === idioma.codigo) $(a).attr('aria-current', 'page');
    else $(a).removeAttr('aria-current');
  });
  $('#langAtual').text(idioma.lang.slice(0, 2).toUpperCase());
}

/* WhatsApp com destino real no HTML, já com a mensagem no idioma da página. */
function aplicarWhatsApp($, whatsapp, meta){
  if(!whatsapp) return;
  const href = 'https://wa.me/' + whatsapp + '?text=' + encodeURIComponent(meta.whatsapp || '');
  $('.wa-link').attr('href', href).attr('target', '_blank').attr('rel', 'noopener');
}

/* Os poucos textos que o JavaScript ainda escreve depois da carga. */
function aplicarRuntime($, d, meta, faltando){
  const runtime = {};
  if(d){
    CHAVES_DE_RUNTIME.forEach(k => { if(d[k] != null) runtime[k] = d[k]; else faltando.add(k); });
  }
  runtime['wa.texto'] = meta.whatsapp || '';
  const alvo = $('script#textos-runtime');
  if(!alvo.length) throw new Error('index.html sem <script id="textos-runtime">');
  alvo.text(`window.ACEBLIND_T = ${jsonEmScript(runtime)};`);
}

/* Mapa do site no rodapé: um link para cada página do idioma. */
function aplicarRodape($, idioma, paginas){
  const r = ROTULOS[idioma.codigo];
  const doIdioma = paginas.filter(p => p.idioma === idioma);
  const colunas = Object.entries(SECOES).map(([secao, config]) => {
    const itens = naOrdem(doIdioma.filter(p => p.secao === secao && !p.hub));
    if(!itens.length) return '';
    const hub = config.hub && doIdioma.find(p => p.id === config.hub);
    const titulo = hub ? `<a href="${hub.caminho}">${escapar(r[config.rotulo])}</a>` : escapar(r[config.rotulo]);
    const links = itens.map(p => `<li><a href="${p.caminho}">${escapar(p.rotulo)}</a></li>`).join('');
    return `<div class="foot__col"><h2>${titulo}</h2><ul>${links}</ul></div>`;
  }).join('');
  $('#mapaDoSite').html(colunas);
}

function cartoes(lista){
  return lista.map(p => `<a class="recurso" href="${p.caminho}"><b>${escapar(p.rotulo)}</b><span>${escapar(p.resumo)}</span></a>`).join('');
}

function finalizar($, grafo){
  $('head').append(`<script type="application/ld+json">${jsonEmScript(grafo)}</script>\n`);
  /* Os <link> removidos e recolocados deixam linhas vazias no lugar. */
  return $.html().replace(/\n{3,}/g, '\n\n');
}

/* ---- home -------------------------------------------------------------------- */

function gerarHome(fonte, idioma, traducoes, paginas, whatsapp){
  const meta = traducoes.meta[idioma.codigo];
  if(!meta) throw new Error('ACEBLIND_META sem a entrada ' + idioma.codigo);
  const faltando = new Set();
  const { $, d } = traduzir(fonte, idioma, traducoes, faltando);

  const alternativos = IDIOMAS.map(i => ({ idioma: i, caminho: i.caminho }));
  aplicarCabeca($, idioma, {
    titulo: meta.title, descricao: meta.description,
    ogTitulo: meta.ogTitle, ogDescricao: meta.ogDescription,
    caminho: idioma.caminho, alternativos,
  });
  aplicarSeletor($, idioma, alternativos);
  aplicarWhatsApp($, whatsapp, meta);
  aplicarRuntime($, d, meta, faltando);
  aplicarRodape($, idioma, paginas);

  /* Produto primeiro: quem está na home veio avaliar o sistema. */
  const daSecao = secao => naOrdem(paginas.filter(p => p.idioma === idioma && !p.hub && p.secao === secao));
  const destaques = [...daSecao('produto'), ...daSecao('ferramentas')];
  if(destaques.length) $('#recursosGrade').html(cartoes(destaques));
  else $('#recursos').remove();

  if(faltando.size) console.warn(`  ! ${idioma.codigo}: ${faltando.size} chave(s) sem tradução, ficaram em português:`, [...faltando].join(', '));
  return finalizar($, dadosDaHome($, idioma, meta, whatsapp));
}

/* ---- páginas internas --------------------------------------------------------- */

function migalhasDe(pagina, paginas){
  const { idioma } = pagina;
  const r = ROTULOS[idioma.codigo];
  const lista = [{ nome: r.inicio, caminho: idioma.caminho }];
  const hubId = SECOES[pagina.secao].hub;
  const hub = hubId && pagina.id !== hubId && paginas.find(p => p.id === hubId && p.idioma === idioma);
  if(hub) lista.push({ nome: hub.rotulo, caminho: hub.caminho });
  lista.push({ nome: pagina.rotulo, caminho: pagina.caminho });
  return lista;
}

function gerarInterna(fonte, pagina, ctx){
  const { traducoes, paginas, whatsapp, css } = ctx;
  const { idioma } = pagina;
  const r = ROTULOS[idioma.codigo];
  const meta = traducoes.meta[idioma.codigo];
  const faltando = new Set();
  const { $, d } = traduzir(fonte, idioma, traducoes, faltando);

  const alternativos = versoes(paginas, pagina).map(p => ({ idioma: p.idioma, caminho: p.caminho }));
  aplicarCabeca($, idioma, {
    titulo: pagina.titulo, descricao: pagina.descricao,
    ogTitulo: pagina.titulo, ogDescricao: pagina.descricao,
    caminho: pagina.caminho, alternativos,
  });
  $('meta[property="og:type"]').attr('content', pagina.secao === 'guias' && !pagina.hub ? 'article' : 'website');
  aplicarSeletor($, idioma, alternativos);

  /* Do <main> da home, só fica a chamada final com o formulário: todo mundo que
     chega numa página interna tem de poder virar lead sem voltar para a home. */
  const demo = $('#demo').clone();
  const migalhas = migalhasDe(pagina, paginas);
  const data = new Intl.DateTimeFormat(idioma.lang, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(pagina.atualizado + 'T12:00:00Z'));

  const trilha = migalhas.map((m, i) => (i === migalhas.length - 1
    ? `<li aria-current="page">${escapar(m.nome)}</li>`
    : `<li><a href="${m.caminho}">${escapar(m.nome)}</a></li>`)).join('');

  const doHub = pagina.hub
    ? naOrdem(paginas.filter(p => p.idioma === idioma && p.secao === pagina.hub && !p.hub))
    : [];
  const relacionados = pagina.relacionados.map(id => paginas.find(p => p.id === id && p.idioma === idioma));

  $('main#conteudo').html(`
<section class="pg-topo">
  <div class="wrap">
    <nav class="migalhas" aria-label="${escapar(r.migalhas)}"><ol>${trilha}</ol></nav>
    <h1>${pagina.h1}</h1>
    ${pagina.lead ? `<p class="lead">${pagina.lead}</p>` : ''}
    ${pagina.secao === 'guias' && !pagina.hub ? `<p class="pg-data">${escapar(r.atualizado)} ${escapar(data)}</p>` : ''}
  </div>
</section>
<div class="pg-corpo">
  <div class="wrap">
    <article class="prosa${pagina.ferramenta ? ' prosa--larga' : ''}">
${pagina.corpo}
    </article>
    ${doHub.length ? `<div class="recursos">${cartoes(doHub)}</div>` : ''}
    ${relacionados.length ? `<aside class="pg-relacionados"><h2>${escapar(r.veja)}</h2><div class="recursos">${cartoes(relacionados)}</div></aside>` : ''}
  </div>
</div>`);
  $('main#conteudo').append(demo);

  /* Âncoras da home (#planos, #faq...) passam a apontar para a home do idioma.
     As que existem nesta página, como #demo, ficam. */
  $('header.nav a[href^="#"], footer.foot a[href^="#"], .wa[href^="#"]').each((_, a) => {
    const alvo = $(a).attr('href');
    if(alvo === '#top') $(a).attr('href', idioma.caminho);
    else if(alvo.length > 1 && !$(alvo).length) $(a).attr('href', idioma.caminho + alvo);
  });

  aplicarWhatsApp($, whatsapp, meta);
  aplicarRuntime($, d, meta, faltando);
  aplicarRodape($, idioma, paginas);

  $('head style').first().append('\n' + css);
  $('script#js-home').remove();

  /* A ferramenta grátis roda inteira no navegador. O JavaScript vai dentro da
     página: sem requisição a mais, e funciona depois de aberta mesmo sem rede. */
  if(pagina.ferramenta){
    const js = ['calculos.js', 'comum.js', `${pagina.ferramenta}.js`]
      .map(n => readFileSync(join(AQUI, 'ferramentas', n), 'utf8'))
      .join('\n');
    $('body').append(`<script>${js.replace(/<\/script/gi, '<\\/script')}</script>\n`);
  }

  return finalizar($, dadosDaInterna($, pagina, migalhas, whatsapp));
}

/* ---- sitemap ------------------------------------------------------------------ */

function sitemap(paginas){
  const bloco = (caminho, alternativos, lastmod) => {
    const linhas = [`    <loc>${url(caminho)}</loc>`];
    if(lastmod) linhas.push(`    <lastmod>${lastmod}</lastmod>`);
    if(alternativos.length > 1){
      const padrao = alternativos.find(a => a.idioma.codigo === 'pt-BR') || alternativos[0];
      alternativos.forEach(a => linhas.push(`    <xhtml:link rel="alternate" hreflang="${a.idioma.lang}" href="${url(a.caminho)}"/>`));
      linhas.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${url(padrao.caminho)}"/>`);
    }
    return `  <url>\n${linhas.join('\n')}\n  </url>`;
  };

  const homes = IDIOMAS.map(i => ({ idioma: i, caminho: i.caminho }));
  const urls = [
    /* Sem lastmod na home de propósito: ela não tem uma data confiável, e o
       Google passa a ignorar o campo de quem informa data errada. */
    ...IDIOMAS.map(i => bloco(i.caminho, homes)),
    ...paginas.map(p => bloco(p.caminho, versoes(paginas, p).map(v => ({ idioma: v.idioma, caminho: v.caminho })), p.atualizado)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`;
}

/* ---- conferência do que foi gerado --------------------------------------------- */

function arquivosHtml(pasta){
  return readdirSync(pasta).flatMap(nome => {
    const caminho = join(pasta, nome);
    if(statSync(caminho).isDirectory()) return arquivosHtml(caminho);
    return nome.endsWith('.html') ? [caminho] : [];
  });
}

/* Todo link interno tem de levar a algo que existe, e toda âncora a um id. */
function conferirLinks(){
  const erros = [];
  const paraDisco = caminho => join(DIST, caminho.endsWith('/') ? caminho + 'index.html' : caminho);

  for(const arquivo of arquivosHtml(DIST)){
    if(arquivo.endsWith('404.html')) continue;
    const origem = '/' + relative(DIST, arquivo).split(sep).join('/');
    const $ = cheerio.load(readFileSync(arquivo, 'utf8'));

    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if(!href.startsWith('/') && !href.startsWith('#')) return;
      const [caminho, ancora] = href.split('#');
      const destino = caminho ? paraDisco(caminho.split('?')[0]) : arquivo;
      if(!existsSync(destino)){ erros.push(`${origem}: link quebrado para ${href}`); return; }
      if(ancora){
        const $d = caminho ? cheerio.load(readFileSync(destino, 'utf8')) : $;
        if(!$d(`[id="${ancora}"]`).length) erros.push(`${origem}: âncora inexistente ${href}`);
      }
    });

    const h1s = $('h1').length;
    if(h1s !== 1) erros.push(`${origem}: ${h1s} tags <h1> (deve ser uma)`);
  }
  if(erros.length) throw new Error('Conferência do site reprovou:\n  ' + erros.join('\n  '));
}

/* ---------------------------------------------------------------------------- */

const fonte = readFileSync(join(AQUI, 'index.html'), 'utf8');
const traducoes = carregarTraducoes();
const whatsapp = numeroWhatsApp(fonte);
if(!whatsapp) console.warn('  ! ACEBLIND_WHATSAPP vazio: os botões de WhatsApp vão levar ao formulário');

const paginas = lerPaginas();
conferirPaginas(paginas);
const css = readFileSync(join(AQUI, 'conteudo', 'conteudo.css'), 'utf8');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
if(existsSync(join(AQUI, 'public'))) cpSync(join(AQUI, 'public'), DIST, { recursive: true });

function gravar(caminho, html){
  const destino = join(DIST, caminho, 'index.html');
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, html);
}

for(const idioma of IDIOMAS){
  gravar(idioma.caminho, gerarHome(fonte, idioma, traducoes, paginas, whatsapp));
  console.log(`  ✓ ${idioma.codigo.padEnd(5)} → dist${idioma.caminho}index.html`);
}
for(const pagina of paginas){
  gravar(pagina.caminho, gerarInterna(fonte, pagina, { traducoes, paginas, whatsapp, css }));
}
console.log(`  ✓ ${paginas.length} páginas internas`);

writeFileSync(join(DIST, 'sitemap.xml'), sitemap(paginas));
console.log('  ✓ sitemap.xml com', IDIOMAS.length + paginas.length, 'URLs');

conferirLinks();
console.log('  ✓ links internos e H1 conferidos');
