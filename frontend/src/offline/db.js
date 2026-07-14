/**
 * Substrato de persistência offline (IndexedDB via `idb`).
 *
 * Fornece 4 object stores:
 *  - `mutationQueue`  — fila DURÁVEL de escritas feitas offline (reenviadas no sync).
 *  - `entities`       — réplica local das linhas do banco (cache de leitura offline +
 *                       base do cálculo financeiro exato). Chave: `"{table}:{id}"`.
 *  - `conflicts`      — ops rejeitadas no replay (para revisão do operador).
 *  - `meta`           — chaves diversas (deviceId, cursores de sincronização).
 *
 * Este módulo é só o acesso ao IndexedDB. A lógica de fila/sync fica em
 * `queue.js` / `syncEngine.js`; as regras de negócio em `domainRules.js`.
 */
import { openDB } from 'idb';

const DB_NAME = 'poker-offline';
const DB_VERSION = 1;

let _dbPromise = null;

export const getDB = () => {
  if (!_dbPromise) {
    _dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('mutationQueue')) {
          const q = db.createObjectStore('mutationQueue', { keyPath: 'id' });
          q.createIndex('status', 'status');
          q.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('entities')) {
          const e = db.createObjectStore('entities', { keyPath: 'key' });
          e.createIndex('table', 'table');
        }
        if (!db.objectStoreNames.contains('conflicts')) {
          db.createObjectStore('conflicts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
      },
    });
  }
  return _dbPromise;
};

// ── uuid (crypto.randomUUID em contexto seguro; fallback simples) ──────────────
export const uuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback RFC4122 v4 (suficiente para chave local)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ── meta ───────────────────────────────────────────────────────────────────────
export const getMeta = async (k, fallback = null) => {
  const db = await getDB();
  const row = await db.get('meta', k);
  return row ? row.v : fallback;
};

export const setMeta = async (k, v) => {
  const db = await getDB();
  await db.put('meta', { k, v });
  return v;
};

/** Id estável deste dispositivo/navegador (gerado 1x). */
export const getDeviceId = async () => {
  let id = await getMeta('deviceId');
  if (!id) {
    id = uuid();
    await setMeta('deviceId', id);
  }
  return id;
};

// ── entities (réplica local) ─────────────────────────────────────────────────
const entKey = (table, id) => `${table}:${id}`;

export const putEntity = async (table, row) => {
  if (!row || row.id == null) return null;
  const db = await getDB();
  await db.put('entities', { key: entKey(table, row.id), table, id: row.id, row });
  return row;
};

/** Grava muitas linhas de uma tabela numa transação só. */
export const putEntities = async (table, rows) => {
  if (!rows || rows.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction('entities', 'readwrite');
  await Promise.all(
    rows
      .filter((r) => r && r.id != null)
      .map((r) => tx.store.put({ key: entKey(table, r.id), table, id: r.id, row: r }))
  );
  await tx.done;
  return rows.length;
};

export const getEntity = async (table, id) => {
  const db = await getDB();
  const rec = await db.get('entities', entKey(table, id));
  return rec ? rec.row : null;
};

export const getAllByTable = async (table) => {
  const db = await getDB();
  const recs = await db.getAllFromIndex('entities', 'table', table);
  return recs.map((r) => r.row);
};

export const deleteEntity = async (table, id) => {
  const db = await getDB();
  await db.delete('entities', entKey(table, id));
};

/** Remove todas as linhas de uma ou mais tabelas da réplica (ex.: ao trocar de stage). */
export const clearTables = async (tables) => {
  const list = Array.isArray(tables) ? tables : [tables];
  const db = await getDB();
  const tx = db.transaction('entities', 'readwrite');
  for (const table of list) {
    let cursor = await tx.store.index('table').openCursor(table);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
};

// ── mutationQueue ────────────────────────────────────────────────────────────
export const enqueueMutation = async (entry) => {
  const db = await getDB();
  await db.put('mutationQueue', entry);
  return entry;
};

export const getQueue = async () => {
  const db = await getDB();
  const all = await db.getAll('mutationQueue');
  // ordem causal: pela criação
  return all.sort((a, b) => a.createdAt - b.createdAt);
};

export const getPendingMutations = async () => {
  const all = await getQueue();
  return all.filter((m) => m.status === 'pending' || m.status === 'error');
};

export const getPendingCount = async () => {
  const db = await getDB();
  const all = await db.getAllFromIndex('mutationQueue', 'status', 'pending');
  const errored = await db.getAllFromIndex('mutationQueue', 'status', 'error');
  return all.length + errored.length;
};

export const updateMutation = async (id, patch) => {
  const db = await getDB();
  const cur = await db.get('mutationQueue', id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await db.put('mutationQueue', next);
  return next;
};

export const removeMutation = async (id) => {
  const db = await getDB();
  await db.delete('mutationQueue', id);
};

// ── conflicts ────────────────────────────────────────────────────────────────
export const addConflict = async (conflict) => {
  const db = await getDB();
  await db.put('conflicts', conflict);
  return conflict;
};

export const getConflicts = async () => {
  const db = await getDB();
  return db.getAll('conflicts');
};

export const removeConflict = async (id) => {
  const db = await getDB();
  await db.delete('conflicts', id);
};

/** Limpa TUDO (usado no logout). */
export const clearOfflineDB = async () => {
  const db = await getDB();
  await Promise.all(
    ['mutationQueue', 'entities', 'conflicts'].map((s) => db.clear(s))
  );
  // preserva `meta.deviceId`
};
