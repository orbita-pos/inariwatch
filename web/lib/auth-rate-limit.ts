/**
 * General-purpose in-memory rate limiter for auth endpoints.
 * Tracks attempts per key (IP or email) with fixed windows.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(namespace: string): Map<string, RateLimitEntry> {
  let store = stores.get(namespace);
  if (!store) {
    store = new Map();
    stores.set(namespace, store);
  }
  return store;
}

/**
 * Check whether a request identified by `key` in a given `namespace` is allowed.
 *
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`.
 */
export function rateLimit(
  namespace: string,
  key: string,
  { windowMs = 60_000, max = 5 }: { windowMs?: number; max?: number } = {}
): { allowed: boolean; retryAfterSeconds?: number } {
  const store = getStore(namespace);
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (entry.count < max) {
    entry.count++;
    return { allowed: true };
  }

  const retryAfterSeconds = Math.ceil(
    (entry.windowStart + windowMs - now) / 1000
  );
  return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
}

// Periodic cleanup — remove entries older than 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [, store] of stores) {
    for (const [key, entry] of store) {
      if (now - entry.windowStart >= 300_000) store.delete(key);
    }
  }
}, 300_000);
if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
  cleanupTimer.unref();
}
