/**
 * Estado de conectividade — SINGLETON (fora do React) para que código não-React
 * (o wrapper axios em `apiOffline.js`) também possa ler `isOnline()` e sinalizar
 * `markOffline()` num erro de rede.
 *
 * "Online" de verdade = `navigator.onLine` E o último heartbeat ao backend passou.
 * `navigator.onLine` sozinho mente (diz online só por estar numa rede local sem
 * internet), então o heartbeat a `GET /health` é o sinal decisivo, reforçado pela
 * ideia de "N falhas consecutivas" (mesmo padrão do useTimerSync).
 */
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';
const HEARTBEAT_MS = 10000;
const FAILS_TO_OFFLINE = 2;

/** Evento (no window) disparado quando a fila de mutações muda. */
export const OFFLINE_QUEUE_EVENT = 'offline-queue-changed';

let _online = typeof navigator !== 'undefined' ? navigator.onLine : true;
let _fails = 0;
let _heartbeatTimer = null;
let _started = false;
const _listeners = new Set();

export const isOnline = () => _online;

export const subscribe = (fn) => {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
};

const _emit = () => {
  for (const fn of _listeners) {
    try { fn(_online); } catch (e) { /* ignore listener errors */ }
  }
};

const _set = (online) => {
  if (online === _online) return;
  _online = online;
  _emit();
};

/** Chamado pelo wrapper axios quando uma request falha por rede. */
export const markOffline = () => {
  _fails += 1;
  if (_fails >= FAILS_TO_OFFLINE) _set(false);
};

/** Chamado quando qualquer request tem sucesso. */
export const markOnline = () => {
  _fails = 0;
  _set(true);
};

const ping = async () => {
  // navigator.onLine=false é conclusivo: sem rede.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    _fails = FAILS_TO_OFFLINE;
    _set(false);
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${API_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (res.ok) markOnline();
    else markOffline();
  } catch (e) {
    markOffline();
  }
};

export const startHeartbeat = () => {
  if (_started) return;
  _started = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', ping);
    window.addEventListener('offline', () => { _fails = FAILS_TO_OFFLINE; _set(false); });
  }
  ping(); // checagem imediata
  _heartbeatTimer = setInterval(ping, HEARTBEAT_MS);
};

export const stopHeartbeat = () => {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
  _started = false;
};

/** Força uma re-checagem imediata (ex.: ao voltar o foco / após re-login). */
export const recheck = () => ping();
