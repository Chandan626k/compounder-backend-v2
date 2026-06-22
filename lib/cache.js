/**
 * lib/cache.js
 * ─────────────────────────────────────────────────────────
 * In-memory LRU cache + sliding-window rate limiter
 * No Redis / external dependency needed for Vercel free tier
 *
 * NOTE: Vercel Serverless Functions are stateless between cold starts.
 * Cache survives within the same warm instance (~5-30 min).
 * For cross-instance caching, swap the cache store with Vercel KV or Upstash Redis.
 * ─────────────────────────────────────────────────────────
 */

/* ── CACHE ── */
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000;  // 6 hours per stock
const CACHE_MAX     = 200;                    // max entries before LRU eviction

const cacheStore = new Map();   // key → { data, expiresAt, hits }

export function cacheGet(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  entry.hits++;
  return entry.data;
}

export function cacheSet(key, data) {
  // LRU eviction: remove oldest if at capacity
  if (cacheStore.size >= CACHE_MAX) {
    const oldest = [...cacheStore.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) cacheStore.delete(oldest[0]);
  }
  cacheStore.set(key, {
    data,
    expiresAt : Date.now() + CACHE_TTL_MS,
    createdAt : new Date().toISOString(),
    hits      : 0,
  });
}

export function cacheStats() {
  const entries = [...cacheStore.values()];
  return {
    size       : cacheStore.size,
    totalHits  : entries.reduce((s, e) => s + e.hits, 0),
    oldestEntry: entries.length
      ? new Date(Math.min(...entries.map(e => e.expiresAt - CACHE_TTL_MS))).toISOString()
      : null,
  };
}

/* ── RATE LIMITER ── */
// Sliding window: max N requests per IP per window
const RATE_LIMIT     = 10;               // requests
const RATE_WINDOW_MS = 60 * 1000;        // per 60 seconds

const rateLimitStore = new Map();        // ip → [timestamp, ...]

export function isRateLimited(ip) {
  const now      = Date.now();
  const window   = now - RATE_WINDOW_MS;
  const requests = (rateLimitStore.get(ip) || []).filter(t => t > window);
  requests.push(now);
  rateLimitStore.set(ip, requests);

  // Cleanup old IPs every ~500 requests to prevent memory leak
  if (Math.random() < 0.002) {
    for (const [k, v] of rateLimitStore) {
      if (v.every(t => t < window)) rateLimitStore.delete(k);
    }
  }

  return {
    limited   : requests.length > RATE_LIMIT,
    remaining : Math.max(0, RATE_LIMIT - requests.length),
    resetAt   : new Date(requests[0] + RATE_WINDOW_MS).toISOString(),
    count     : requests.length,
  };
}
