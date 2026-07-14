/**
 * Motor de sincronização. Quando online, reenvia a fila de mutações ao backend em
 * ORDEM via `POST /sync/batch` (o servidor reexecuta cada op de forma idempotente e
 * devolve o status por op). Dispara ao reconectar, no start do app e periodicamente.
 *
 * Fluxo de cada op no retorno:
 *  - applied / duplicate  → remove da fila (sucesso ou já aplicado antes).
 *  - conflict             → move para `conflicts` (revisão do operador).
 *  - error                → mantém pendente (retry no próximo flush, com backoff).
 * Depois do flush, o pull-refresh (rebaixar snapshot do servidor) é feito na 1E.
 */
import api from '../config/api';
import { isOnline, markOffline, markOnline, subscribe } from './connectivity';
import {
  getPendingMutations,
  updateMutation,
  removeMutation,
  addConflict,
} from './db';
import { notifyQueueChanged } from './queue';

let _flushing = false;
let _started = false;
let _timer = null;

export const flush = async () => {
  if (_flushing || !isOnline()) return { skipped: true };

  let pending;
  try {
    pending = await getPendingMutations();
  } catch (e) {
    return { error: 'db' };
  }
  if (pending.length === 0) return { empty: true };

  _flushing = true;
  try {
    const ops = pending.map((m) => ({
      clientMutationId: m.clientMutationId,
      kind: m.kind,
      method: m.method,
      url: m.url,
      body: m.body,
      params: m.params,
      clientEntityIds: m.clientEntityIds,
      deps: m.deps,
    }));

    let res;
    try {
      res = await api.post('/sync/batch', { ops });
      markOnline();
    } catch (err) {
      if (!err.response) {
        markOffline();
        return { offline: true };
      }
      // 401 (token expirado offline) ou 5xx: deixa tudo pendente p/ retry
      return { httpError: err.response.status };
    }

    const results = (res.data && res.data.results) || [];
    const byId = new Map(results.map((r) => [r.clientMutationId, r]));

    for (const m of pending) {
      const r = byId.get(m.clientMutationId);
      if (!r) continue; // servidor parou antes desta (ex.: dependência) — fica pendente
      if (r.status === 'applied' || r.status === 'duplicate') {
        await removeMutation(m.id);
      } else if (r.status === 'conflict') {
        await updateMutation(m.id, { status: 'conflict', error: r.error || 'conflito' });
        await addConflict({
          id: m.id,
          mutation: m,
          reason: r.error || 'conflito',
          serverId: r.serverId || null,
          at: Date.now(),
        });
      } else {
        await updateMutation(m.id, {
          status: 'error',
          attempts: (m.attempts || 0) + 1,
          error: r.error || 'erro',
        });
      }
    }

    notifyQueueChanged();
    return { done: true, results };
  } finally {
    _flushing = false;
  }
};

const safeFlush = () => { flush().catch(() => {}); };

/** Liga os gatilhos de flush: reconexão + periódico. Chamado 1x no start do app. */
export const startSyncEngine = () => {
  if (_started) return;
  _started = true;
  subscribe((online) => { if (online) safeFlush(); });
  safeFlush(); // tenta esvaziar o que ficou de uma sessão anterior
  _timer = setInterval(() => { if (isOnline()) safeFlush(); }, 15000);
};

export const stopSyncEngine = () => {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
};
