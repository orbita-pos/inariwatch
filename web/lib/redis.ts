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
