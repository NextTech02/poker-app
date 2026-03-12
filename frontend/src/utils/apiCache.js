/**
 * Lightweight in-memory API cache with stale-time (B3).
 * Replacement for React Query in simpler scenarios — prevents re-fetching
 * data that hasn't changed when navigating between pages.
 *
 * Usage:
 *   import { cachedGet, invalidateCache } from '../utils/apiCache';
 *   const data = await cachedGet(api, '/tournaments', 30000);
 */

const _cache = new Map();

/**
 * Fetch with stale-time cache.
 * @param {object} api      - Axios instance
 * @param {string} url      - Endpoint URL (used as cache key)
 * @param {number} staleMs  - How long before the entry is considered stale (ms)
 * @param {object} params   - Optional query params (appended to key)
 */
export const cachedGet = async (api, url, staleMs = 30000, params = null) => {
  const key = params ? `${url}?${JSON.stringify(params)}` : url;
  const entry = _cache.get(key);

  if (entry && Date.now() - entry.ts < staleMs) {
    return entry.data;
  }

  const res = await api.get(url, params ? { params } : undefined);
  _cache.set(key, { data: res.data, ts: Date.now() });
  return res.data;
};

/**
 * Invalidate a specific cache entry (call after mutations).
 * @param {string} url - Exact URL to invalidate
 */
export const invalidateCache = (url) => {
  for (const key of _cache.keys()) {
    if (key === url || key.startsWith(url + '?')) {
      _cache.delete(key);
    }
  }
};

/**
 * Invalidate all entries whose key starts with a given prefix.
 * Useful after mutations that affect multiple queries.
 * @param {string} prefix - e.g. '/tournaments'
 */
export const invalidateCacheByPrefix = (prefix) => {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
};

/** Clear the entire cache (use on logout). */
export const clearCache = () => _cache.clear();
