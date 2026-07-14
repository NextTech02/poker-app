/**
 * Fila de mutações offline. Constrói e persiste as entradas (em `db.js`) e avisa a
 * UI (evento `OFFLINE_QUEUE_EVENT`). O reenvio ao servidor é do `syncEngine.js`.
 *
 * Cada entrada carrega tudo que o `/sync/batch` precisa para reexecutar a operação
 * de forma idempotente: método, url, body/params e um `clientMutationId` (chave de
 * idempotência). Escritas que criam linhas passam `clientEntityIds` (ids uuid
 * gerados no cliente) para que ops seguintes na mesma sessão offline possam
 * referenciá-las antes do sync.
 */
import { enqueueMutation, uuid, getDeviceId } from './db';
import { OFFLINE_QUEUE_EVENT } from './connectivity';

export const notifyQueueChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT));
  }
};

/**
 * Enfileira uma mutação.
 * @param {object} m
 * @param {string} m.kind         rótulo lógico (ex.: 'register', 'rebuy', 'sangria')
 * @param {string} m.method       'post' | 'patch' | 'delete' ...
 * @param {string} m.url          caminho relativo ao backend (ex.: '/tournament-players')
 * @param {object} [m.body]       corpo JSON
 * @param {object} [m.params]     query params
 * @param {string[]} [m.deps]     ids de outras entradas da fila que devem ir antes
 * @param {object} [m.clientEntityIds] ids uuid gerados no cliente ({table:id})
 * @param {string} [m.clientMutationId] chave de idempotência (gerada se omitida)
 * @param {object} [m.meta]       dados p/ a tela de conflitos (nome do jogador, etc.)
 */
export const enqueue = async (m) => {
  const entry = {
    id: uuid(),
    deviceId: await getDeviceId(),
    kind: m.kind,
    method: (m.method || 'post').toLowerCase(),
    url: m.url,
    body: m.body || null,
    params: m.params || null,
    deps: m.deps || [],
    clientEntityIds: m.clientEntityIds || {},
    clientMutationId: m.clientMutationId || uuid(),
    meta: m.meta || {},
    createdAt: Date.now(),
    attempts: 0,
    status: 'pending', // pending | syncing | error | conflict | done
    error: null,
  };
  await enqueueMutation(entry);
  notifyQueueChanged();
  return entry;
};
