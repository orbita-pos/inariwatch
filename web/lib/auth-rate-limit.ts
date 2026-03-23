/**
 * DB-backed rate limiter for auth and general endpoints.
 * Uses a single atomic UPSERT per check — safe across serverless instances.
 */

import { db, rateLimits } from "@/lib/db";
import { eq, lt, sql } from "drizzle-orm";

/**
 * Check whether a request identified by `key` in a given `namespace` is allowed.
 * Uses an atomic INSERT … ON CONFLICT UPDATE to avoid race conditions.
 *
 * @returns `{ allowed: true }` or `{ allowed: false, retryAfterSeconds }`.
 */
export async function rateLimit(
  namespace: string,
  key: string,
  { windowMs = 60_000, max = 5 }: { windowMs?: number; max?: number } = {}
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const compositeKey = `${namespace}:${key}`;
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

  if (row.count <= max) {
    return { allowed: true };
  }

  const retryAfterSeconds = Math.ceil(
    (row.windowStart.getTime() + windowMs - Date.now()) / 1000
  );
  return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
}

/**
 * Probabilistic cleanup of expired entries (runs ~1% of calls).
 * Call this from a cron route or let it piggyback on normal traffic.
 */
export async function cleanupExpiredLimits(): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, oneHourAgo));
}
