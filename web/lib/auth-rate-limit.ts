/**
 * Rate limiter — Redis-first (Upstash) with DB fallback.
 * Redis: ~1ms per check. DB fallback: ~30ms per check.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "@/lib/redis";
import { db, rateLimits } from "@/lib/db";
import { eq, lt, sql } from "drizzle-orm";

// ── Redis rate limiters (cached per namespace config) ───────────────────────

const limiters = new Map<string, Ratelimit>();

function getRedisLimiter(windowMs: number, max: number): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;

  const key = `${windowMs}:${max}`;
  if (limiters.has(key)) return limiters.get(key)!;

  const windowSec = Math.ceil(windowMs / 1000);
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
    prefix: "rl",
  });
  limiters.set(key, limiter);
  return limiter;
}

// ── Public API (same signature as before) ───────────────────────────────────

export async function rateLimit(
  namespace: string,
  key: string,
  { windowMs = 60_000, max = 5 }: { windowMs?: number; max?: number } = {}
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const compositeKey = `${namespace}:${key}`;

  // Try Redis first
  const limiter = getRedisLimiter(windowMs, max);
  if (limiter) {
    try {
      const result = await limiter.limit(compositeKey);
      if (result.success) return { allowed: true };
      const retryAfterSeconds = Math.max(Math.ceil((result.reset - Date.now()) / 1000), 1);
      return { allowed: false, retryAfterSeconds };
    } catch {
      // Redis unavailable — fall through to DB
    }
  }

  // DB fallback (original implementation)
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
    (row.windowStart.getTime() + windowMs - Date.now()) / 1000
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
