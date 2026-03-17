/**
 * In-memory rate limiter for webhook endpoints.
 *
 * Tracks requests per IP address using a Map. Expired entries are
 * cleaned up every 5 minutes to prevent unbounded memory growth.
 */

interface RateLimitEntry {
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
const DEFAULT_MAX_REQUESTS = 60; // per window
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Check whether a request from `ip` should be allowed.
 *
 * @param ip            The client IP address (or "unknown")
 * @param windowMs      Sliding window duration in milliseconds (default 60 000)
 * @param maxRequests   Maximum requests allowed within the window (default 60)
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfter }` where
 *          `retryAfter` is the number of seconds until the window resets.
 */
export function checkWebhookRateLimit(
  ip: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  maxRequests: number = DEFAULT_MAX_REQUESTS
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = store.get(ip);

  // No existing entry or window has expired → start fresh
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }

  // Within current window
  if (entry.count < maxRequests) {
    entry.count++;
    return { allowed: true };
  }

  // Over limit — compute seconds remaining in the window
  const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
  return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
}

// ── Periodic cleanup ────────────────────────────────────────────────────────
// Remove entries whose window has fully elapsed so the Map doesn't grow forever.

function cleanup() {
  const now = Date.now();
  for (const [ip, entry] of store) {
    // Use a generous 2× window so we don't race with in-flight checks
    if (now - entry.windowStart >= DEFAULT_WINDOW_MS * 2) {
      store.delete(ip);
    }
  }
}

// Start the cleanup timer. `unref()` ensures this timer does not keep the
// Node.js process alive when everything else has finished.
const cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
  cleanupTimer.unref();
}
