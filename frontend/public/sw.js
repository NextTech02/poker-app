/* Service Worker — faz o app ABRIR sem internet.
 *
 * Por que existe: toda a infraestrutura offline (IndexedDB, fila de mutações,
 * sync) só funciona com o app JÁ carregado na memória do navegador. Sem service
 * worker, bastava o operador dar F5 — ou abrir o app já sem rede — para ver a
 * tela de erro do Chrome. Era por isso que "rodar offline" não funcionava.
 *
 * Estratégias, por tipo de requisição:
 *
 *   navegação (HTML)  -> network-first com fallback para o index.html cacheado.
 *                        Como é uma SPA, QUALQUER rota (/caixa, /control/x...)
 *                        é servida pelo mesmo index.html; o React Router assume
 *                        a partir daí.
 *   /static/**        -> cache-first. Os arquivos têm hash no nome, então são
 *                        imutáveis: se está no cache, está correto.
 *   API / Supabase    -> NUNCA cacheado. Os dados offline vêm do IndexedDB, que
 *                        é a fonte da verdade local; cachear resposta de API
 *                        mostraria saldo/fichas desatualizados como se fossem
 *                        atuais — pior que falhar.
 */

const VERSION = 'v1';
const SHELL_CACHE = `poker-shell-${VERSION}`;
const ASSET_CACHE = `poker-assets-${VERSION}`;

// Mínimo para a aplicação abrir. Os bundles com hash entram via runtime caching.
const SHELL_URLS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll falha inteiro se UM item falhar; individual é mais resiliente.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())   // ativa a versão nova sem esperar
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => ![SHELL_CACHE, ASSET_CACHE].includes(k))
            .map((k) => caches.delete(k))   // limpa versões antigas
      ))
      .then(() => self.clients.claim())     // assume as abas já abertas
  );
});

const isApiRequest = (url) =>
  url.pathname.startsWith('/api') ||
  url.pathname.startsWith('/rest/v1') ||
  url.pathname.startsWith('/auth/v1') ||
  url.pathname.startsWith('/realtime') ||
  url.hostname.includes('supabase') ||
  // backend próprio (dev em :8000, prod em api-*)
  url.port === '8000' ||
  url.hostname.startsWith('api-');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;            // POST/PATCH vão para a fila offline

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!url.protocol.startsWith('http')) return;    // ignora chrome-extension: etc.

  // API nunca é cacheada — deixa falhar para a camada offline tratar.
  if (isApiRequest(url)) return;

  // Navegação: tenta a rede; sem rede, devolve o shell para a SPA assumir.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('/index.html'))
              || (await cache.match('/'))
              || new Response(
                   '<h1>Sem conexão</h1><p>Abra o app uma vez com internet para habilitar o modo offline.</p>',
                   { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
                 );
        })
    );
    return;
  }

  // Demais assets (JS/CSS/imagens/fontes): cache-first, populando em background.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});

// Permite que a página force a ativação de uma versão nova do SW.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
