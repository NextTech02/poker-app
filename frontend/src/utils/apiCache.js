/**
 * Lightweight in-memory API cache with stale-time (B3).
 * Replacement for React Query in simpler scenarios — prevents re-fetching
 * data that hasn't changed when navigating between pages.
 *
 * IMPORTANT: cache keys are scoped by the currently selected stage. The stage
 * travels in the X-Stage-ID header (not in the URL), so without this scoping two
 * different stages would collide on the same key (e.g. "/tournaments") and the
 * UI would show stale data from the previously selected stage. The key is
 * `${stageId}::${url}` so each stage has its own isolated cache namespace.
 *
 * Usage:
 *   import { cachedGet, invalidateCache } from '../utils/apiCache';
 *   const data = await cachedGet(api, '/tournaments', 30000);
 */

import { getSelectedStageId } from './stageUtils';

const _cache = new Map();

// In-flight request dedup: concurrent callers for the same key share one
// network round-trip instead of firing N identical requests (a 5s polling page
// mounted twice, StrictMode double-invoke, etc.). Map<key, Promise>.
const _inflight = new Map();

const _stageScope = () => getSelectedStageId() || 'nostage';

const _buildKey = (url, params) =>
  `${_stageScope()}::${url}${params ? `?${JSON.stringify(params)}` : ''}`;

// The url-part of a key (everything after the first "::"), used by the
// invalidation helpers so callers can keep passing plain URLs.
const _urlPart = (key) => {
  const i = key.indexOf('::');
  return i === -1 ? key : key.slice(i + 2);
};

/**
 * Fetch with stale-time cache (scoped to the selected stage) + in-flight dedup.
 * @param {object} api      - Axios instance
 * @param {string} url      - Endpoint URL
 * @param {number} staleMs  - How long before the entry is considered stale (ms)
 * @param {object} params   - Optional query params (appended to key)
 */
export const cachedGet = async (api, url, staleMs = 30000, params = null) => {
  const key = _buildKey(url, params);
  const entry = _cache.get(key);

  if (entry && Date.now() - entry.ts < staleMs) {
    return entry.data;
  }

  // Reuse an in-flight request for the same key instead of starting another.
  const pending = _inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const res = await api.get(url, params ? { params } : undefined);
      _cache.set(key, { data: res.data, ts: Date.now() });
      return res.data;
    } finally {
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, promise);
  return promise;
};

/**
 * Invalidate a specific cache entry across all stage scopes (call after
 * mutations). Matches on the url-part so callers keep passing plain URLs.
 * @param {string} url - Exact URL to invalidate
 */
export const invalidateCache = (url) => {
  for (const key of _cache.keys()) {
    const u = _urlPart(key);
    if (u === url || u.startsWith(url + '?')) {
      _cache.delete(key);
    }
  }
};

/**
 * Invalidate all entries whose url-part starts with a given prefix.
 * Useful after mutations that affect multiple queries.
 * @param {string} prefix - e.g. '/tournaments'
 */
export const invalidateCacheByPrefix = (prefix) => {
  for (const key of _cache.keys()) {
    if (_urlPart(key).startsWith(prefix)) _cache.delete(key);
  }
};

/** Clear the entire cache (use on logout and on stage switch). */
export const clearCache = () => {
  _cache.clear();
  _inflight.clear();
};
