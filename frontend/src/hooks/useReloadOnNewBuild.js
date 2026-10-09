import { useEffect } from 'react';

/**
 * Recarrega a página sozinha quando sai um deploy novo.
 *
 * Por que existe: o telão fica aberto na TV por dias. A página só busca
 * DADOS (relógio, prêmios); o código e o CSS são os de quando ela foi
 * aberta. Depois de um deploy, a TV continuava mostrando o layout antigo
 * (foi assim que o cliente viu o título minúsculo horas depois da
 * correção já publicada) — e ninguém sobe numa escada para apertar F5.
 *
 * Como: de tempos em tempos lê `/asset-manifest.json` (o CRA gera com o
 * nome do bundle, com hash; o servidor manda sem cache) e compara com o
 * `main.*.js` que está carregado. Mudou = há build novo → atualiza o
 * service worker (para ele pré-cachear os bundles novos) e recarrega.
 * Só em produção: em desenvolvimento o bundle não tem hash.
 */
export const INTERVALO_VERIFICACAO_MS = 5 * 60 * 1000;

const semBarra = (p) => String(p || '').replace(/^\//, '');

/** Caminho do bundle principal carregado nesta página (ex.: static/js/main.abc123.js). */
export const bundleCarregado = () => {
  if (typeof document === 'undefined') return null;
  const script = document.querySelector('script[src*="/static/js/main."]');
  if (!script) return null;
  try {
    return semBarra(new URL(script.src, window.location.origin).pathname);
  } catch (e) {
    return null;
  }
};

/** True se o manifesto publicado aponta para um bundle diferente do carregado. */
export const buildMudou = async (fetchFn = fetch) => {
  const atual = bundleCarregado();
  if (!atual) return false;
  const res = await fetchFn('/asset-manifest.json', { cache: 'no-cache' });
  if (!res || !res.ok) return false;
  const manifesto = await res.json();
  const novo = semBarra(manifesto?.files?.['main.js']);
  if (!novo) return false;
  return novo !== atual;
};

export const useReloadOnNewBuild = (ativo = true) => {
  useEffect(() => {
    if (!ativo || process.env.NODE_ENV !== 'production') return undefined;
    let recarregando = false;

    const checar = async () => {
      if (recarregando) return;
      try {
        if (!(await buildMudou())) return;
        recarregando = true;
        try {
          const reg = await navigator.serviceWorker?.getRegistration?.();
          await reg?.update?.();
        } catch (e) {
          /* sem service worker, o reload normal já baixa o build novo */
        }
        window.location.reload();
      } catch (e) {
        /* sem rede agora: tenta na próxima */
      }
    };

    const intervalo = setInterval(checar, INTERVALO_VERIFICACAO_MS);
    const aoVoltar = () => { if (document.visibilityState === 'visible') checar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, [ativo]);
};

export default useReloadOnNewBuild;
