/**
 * Rate limiter — Redis-first with DB fallback.
 *
 * Backend: rate-limiter-flexible's RateLimiterRedis over the singleton
 * ioredis client from lib/redis.ts. Atomic Lua-script sliding window per
 * key. Sub-millisecond on localhost.
 *
 * If Redis is unreachable (per-call timeout in the ioredis client), the
 * existing DB-backed fixed-window limiter takes over. Algorithms differ
 * slightly (sliding vs fixed) but allowed/denied semantics are equivalent
 * for the rates we use.
 */

import { RateLimiterRedis } from "rate-limiter-flexible";
import { getIoredisClient } from "@/lib/redis";
import { db, rateLimits } from "@/lib/db";
import { eq, lt, sql } from "drizzle-orm";

// ── Per-window-config limiter cache ────────────────────────────────────────

const limiters = new Map<string, RateLimiterRedis>();

function getLimiter(windowMs: number, max: number): RateLimiterRedis | null {
  const ioredis = getIoredisClient();
  if (!ioredis) return null;

  const cacheKey = `${windowMs}:${max}`;
  const cached = limiters.get(cacheKey);
  if (cached) return cached;

  const limiter = new RateLimiterRedis({
    storeClient: ioredis,
    keyPrefix: "rl",
    points: max,
    duration: Math.ceil(windowMs / 1000),
  });
  limiters.set(cacheKey, limiter);
  return limiter;
}

// ── Public API (unchanged signature) ────────────────────────────────────────

export async function rateLimit(
  namespace: string,
  key: string,
  { windowMs = 60_000, max = 5 }: { windowMs?: number; max?: number } = {},
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const compositeKey = `${namespace}:${key}`;

  const limiter = getLimiter(windowMs, max);
  if (limiter) {
    try {
      await limiter.consume(compositeKey);
      return { allowed: true };
    } catch (e) {
      // RateLimiterRes (rejection) carries `msBeforeNext`. Anything else
      // is an actual error — fall through to DB.
      if (e && typeof e === "object" && "msBeforeNext" in e) {
        const ms = Number((e as { msBeforeNext: number }).msBeforeNext);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(Math.ceil(ms / 1000), 1),
        };
      }
      // Real error — fall through.
    }
  }

  // DB fallback (original implementation, unchanged).
  const threshold = new Date(Date.now() - windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key: compositeKey, count: 1, windowStart: new Date() })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStart} < ${threshold} THEN 1 WHEN ${rateLimits.count} < ${max} THEN ${rateLimits.count} + 1 ELSE ${rateLimits.count} END`,
        windowStart: sql`CASE WHEN ${rateLimits.windowStart} < ${threshold} THEN NOW() ELSE ${rateLimits.windowStart} END`,
      },
    })
    .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });

  if (row.count <= max) return { allowed: true };

  const retryAfterSeconds = Math.ceil(
    (row.windowStart.getTime() + windowMs - Date.now()) / 1000,
  );
  return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
}

/**
 * Probabilistic cleanup of expired entries (DB fallback table).
 */
export async function cleanupExpiredLimits(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, oneHourAgo));
}
