/**
 * Camada de acesso com fallback OFFLINE, por cima do axios (`config/api.js`).
 *
 * - `offlineWrite`: online tenta o backend; se cair por REDE (ou já estiver
 *   offline), aplica a mutação na réplica local (`applyLocal`, via domainRules),
 *   enfileira a op e devolve uma resposta SINTÉTICA para a UI seguir.
 * - `offlineRead`: online busca no backend; offline (ou erro de rede) serve da
 *   réplica local (`fromReplica`).
 *
 * Erros do SERVIDOR (4xx/5xx com resposta HTTP) são propagados — só erro de REDE
 * cai para o modo offline.
 */
import api from '../config/api';
import { isOnline, markOffline, markOnline } from './connectivity';
import { enqueue } from './queue';

/** Sem `err.response` = falha de rede/timeout (não chegou resposta do servidor). */
const isNetworkError = (err) => !!err && !err.response;

/**
 * Executa uma escrita com fallback offline.
 * @param {object} o
 * @param {string} o.method        'post' | 'patch' | 'delete' | 'put'
 * @param {string} o.url           caminho backend
 * @param {object} [o.body]
 * @param {object} [o.params]
 * @param {string} o.kind          rótulo lógico p/ a fila
 * @param {string[]} [o.deps]
 * @param {object} [o.clientEntityIds]
 * @param {string} [o.clientMutationId]
 * @param {object} [o.meta]        contexto p/ a tela de conflitos
 * @param {*} [o.synthetic]        `data` devolvido quando offline
 * @param {Function} [o.applyLocal] async: aplica a mutação na réplica (domainRules)
 * @returns {Promise<{data:*, offline:boolean}>}
 */
export const offlineWrite = async (o) => {
  const goOffline = async () => {
    if (o.applyLocal) {
      try { await o.applyLocal(); } catch (e) { /* réplica best-effort */ }
    }
    await enqueue({
      kind: o.kind,
      method: o.method,
      url: o.url,
      body: o.body,
      params: o.params,
      deps: o.deps,
      clientEntityIds: o.clientEntityIds,
      clientMutationId: o.clientMutationId,
      meta: o.meta,
    });
    return { data: o.synthetic ?? { offline: true }, offline: true };
  };

  if (!isOnline()) return goOffline();

  try {
    const res = await api.request({
      method: o.method,
      url: o.url,
      data: o.body,
      params: o.params,
    });
    markOnline();
    return { data: res.data, offline: false };
  } catch (err) {
    if (isNetworkError(err)) {
      markOffline();
      return goOffline();
    }
    throw err; // resposta do servidor (validação/conflito) — deixa a tela tratar
  }
};

/**
 * Leitura com fallback à réplica local quando offline / erro de rede.
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.params]
 * @param {Function} [opts.fromReplica] async: devolve os dados da réplica local
 * @param {*} [opts.fallback] valor se offline e sem fromReplica
 */
export const offlineRead = async (url, opts = {}) => {
  if (isOnline()) {
    try {
      const res = await api.get(url, { params: opts.params });
      markOnline();
      return res.data;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      markOffline();
    }
  }
  if (opts.fromReplica) return opts.fromReplica();
  return opts.fallback ?? null;
};
