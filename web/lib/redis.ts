/**
 * Upstash Redis client — shared across all modules.
 * Uses REST API (HTTP-based), works in Vercel serverless + edge.
 *
 * Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  _redis = new Redis({ url, token });
  return _redis;
}

/**
 * Convenience: get Redis or throw. Use in code paths that require Redis.
 */
export function requireRedis(): Redis {
  const r = getRedis();
  if (!r) throw new Error("Redis not configured (missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN)");
  return r;
}

// ── Daily counter helpers (used by spend-guard, capture caps, etc) ─────────

/**
 * Increment a daily counter by `by` (can be negative for rollback).
 * Key is suffixed with today's UTC date so daily reset is implicit.
 *
 * Returns the new value, or null if Redis is unavailable. Callers MUST
 * handle null as "fail-open" (allow the operation, log a warning).
 *
 * The 25h TTL is just cleanup so we don't leak Redis keys long-term —
 * the date suffix already provides the daily reset semantics.
 */
export async function incrDailyCounterCents(key: string, by: number): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `${key}:${today}`;
    const newVal = await r.incrby(dailyKey, by);
    await r.expire(dailyKey, 90_000); // 25h
    return newVal;
  } catch (err) {
    console.error("[redis] incrDailyCounterCents failed:", err);
    return null;
  }
}

/**
 * Read the current value of a daily counter. Returns 0 if missing or
 * Redis unavailable. Never throws.
 */
export async function getDailyCounterCents(key: string): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const v = await r.get<number | string | null>(`${key}:${today}`);
    if (v == null) return 0;
    return typeof v === "number" ? v : parseInt(String(v), 10);
  } catch (err) {
    console.error("[redis] getDailyCounterCents failed:", err);
    return 0;
  }
}
