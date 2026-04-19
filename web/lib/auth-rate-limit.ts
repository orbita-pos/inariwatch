/**
 * Rate limiter — Redis-first with DB fallback.
 *
 * Two Redis backends are supported behind the same `rateLimit()` API:
 *   USE_LOCAL_REDIS=true  → ioredis + rate-limiter-flexible (sliding window
 *                           via Lua, ~0.5ms localhost).
 *   USE_LOCAL_REDIS!=true → @upstash/ratelimit over Upstash REST (~5-10ms
 *                           round-trip).
 *
 * Both fall through to the DB-backed fixed-window limiter when their Redis
 * is unreachable. Algorithms differ slightly (sliding vs sliding+burst vs
 * fixed) but allowed/denied semantics are equivalent for the rates we use.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { RateLimiterRedis } from "rate-limiter-flexible";
import { getRedis, getIoredisClient } from "@/lib/redis";
import { db, rateLimits } from "@/lib/db";
import { eq, lt, sql } from "drizzle-orm";

// ── Internal limiter abstraction — one of two backends ──────────────────────

interface LimiterCheck {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface InternalLimiter {
  check(key: string): Promise<LimiterCheck>;
}

const limiters = new Map<string, InternalLimiter>();

function getLimiter(windowMs: number, max: number): InternalLimiter | null {
  const cacheKey = `${windowMs}:${max}`;
  const cached = limiters.get(cacheKey);
  if (cached) return cached;

  const windowSec = Math.ceil(windowMs / 1000);

  // Local Redis path: rate-limiter-flexible's RateLimiterRedis. Uses an
  // atomic Lua script + sliding window per key. We share the singleton
  // ioredis client from lib/redis.ts so we don't open a second pool.
  const ioredis = getIoredisClient();
  if (ioredis) {
    const rlf = new RateLimiterRedis({
      storeClient: ioredis,
      keyPrefix: "rl",
      points: max,
      duration: windowSec,
    });
    const impl: InternalLimiter = {
      async check(key) {
        try {
          await rlf.consume(key);
          return { allowed: true };
        } catch (e) {
          // RateLimiterRes (rejection) carries `msBeforeNext`. Anything
          // else is an actual error — let it bubble so the caller's
          // try/catch falls back to DB.
          if (e && typeof e === "object" && "msBeforeNext" in e) {
            const ms = Number((e as { msBeforeNext: number }).msBeforeNext);
            return {
              allowed: false,
              retryAfterSeconds: Math.max(Math.ceil(ms / 1000), 1),
            };
          }
          throw e;
        }
      },
    };
    limiters.set(cacheKey, impl);
    return impl;
  }

  // Upstash REST path: existing @upstash/ratelimit.
  const upstash = getRedis();
  if (!upstash) return null;
  const ratelimit = new Ratelimit({
    // @upstash/ratelimit's type wants the Upstash REST client. When this
    // branch is taken, getRedis() returned exactly that (cast through
    // RedisLike). The cast back is safe here.
    redis: upstash as unknown as ConstructorParameters<typeof Ratelimit>[0]["redis"],
    limiter: Ratelimit.slidingWindow(max, `${windowSec} s`),
    prefix: "rl",
  });
  const impl: InternalLimiter = {
    async check(key) {
      const r = await ratelimit.limit(key);
      if (r.success) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(Math.ceil((r.reset - Date.now()) / 1000), 1),
      };
    },
  };
  limiters.set(cacheKey, impl);
  return impl;
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
      return await limiter.check(compositeKey);
    } catch {
      // Redis unavailable — fall through to DB.
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
