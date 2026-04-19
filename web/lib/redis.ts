/**
 * Redis client — singleton, dual-backend.
 *
 * Two implementations behind one interface (`RedisLike`):
 *
 *   USE_LOCAL_REDIS=true  → Hetzner-local Redis via ioredis (TCP).
 *                            Set REDIS_HOST / REDIS_PORT / REDIS_PASSWORD.
 *   USE_LOCAL_REDIS!=true → Upstash REST via @upstash/redis (HTTP).
 *                            Set UPSTASH_REDIS_REST_URL / _TOKEN.
 *
 * The two backends are wire-incompatible (TCP vs HTTPS), so the flag is
 * the cutover switch. Default behavior is Upstash for backward compat;
 * the flag flips on once the local Redis accessory is healthy and the
 * parallel-run window confirms parity. See web/config/deploy.yml for
 * accessory definition and project_upstash_migration_plan.md for context.
 *
 * The Upstash REST client is structurally a superset of the methods we
 * use (get/set/incr/incrby/expire/hset/hget/hgetall/del/pipeline), so
 * we can cast it to RedisLike without an adapter. The ioredis path uses
 * a thin adapter to (a) auto-JSON-parse on get like Upstash does,
 * (b) accept Upstash's `{ ex, nx }` set-options object form, and
 * (c) unwrap pipeline results from `[err, value][]` to `value[]`.
 */

import { Redis as UpstashRedis } from "@upstash/redis";
import IoRedis from "ioredis";

// ── Public interface — the Upstash subset our app uses ─────────────────────

export interface RedisLike {
  get<T = string>(key: string): Promise<T | null>;
  /** Value may be any JSON-serializable shape — Upstash auto-stringifies, the
   *  ioredis adapter mirrors that behavior so callers don't have to switch
   *  serialization strategy when the backend flips. */
  set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<"OK" | null>;
  incr(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, fields: Record<string, string | number>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall<T = Record<string, string>>(key: string): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
  pipeline(): RedisPipeline;
}

export interface RedisPipeline {
  incr(key: string): RedisPipeline;
  incrby(key: string, by: number): RedisPipeline;
  set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): RedisPipeline;
  expire(key: string, seconds: number): RedisPipeline;
  exec(): Promise<unknown[]>;
}

// ── Singleton state ────────────────────────────────────────────────────────

let _redis: RedisLike | null = null;
let _ioredis: IoRedis | null = null;

function useLocal(): boolean {
  return process.env.USE_LOCAL_REDIS === "true";
}

/**
 * Raw ioredis client — for libraries that need direct access (e.g.
 * rate-limiter-flexible's RateLimiterRedis). Only available when
 * USE_LOCAL_REDIS=true and connection vars are set. Returns null otherwise.
 */
export function getIoredisClient(): IoRedis | null {
  if (!useLocal()) return null;
  if (_ioredis) return _ioredis;

  const host = process.env.REDIS_HOST;
  const password = process.env.REDIS_PASSWORD;
  if (!host || !password) return null;

  _ioredis = new IoRedis({
    host,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password,
    // Fail fast if the box is down so callers fall back to DB instead of
    // hanging on the offline queue. Matches Upstash's "throws on failure"
    // semantics for the existing fallback paths in callers.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    // Keep the connection alive — Hetzner is in the same DC, latency is
    // < 1ms, but the box can be quiet between cron ticks.
    keepAlive: 30_000,
  });

  // Swallow connection errors so they don't crash the Node process when
  // Redis is briefly unavailable. Callers that wrap in try/catch will see
  // the per-command failure; everyone else relies on the DB fallback.
  _ioredis.on("error", (err) => {
    console.error("[redis/ioredis] connection error:", err.message);
  });

  return _ioredis;
}

export function getRedis(): RedisLike | null {
  if (_redis) return _redis;

  if (useLocal()) {
    const client = getIoredisClient();
    if (!client) return null;
    _redis = ioredisAdapter(client);
    return _redis;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  // Upstash REST client is a structural superset of RedisLike for the
  // methods we use. Two minor signature differences (set options shape,
  // pipeline.exec result format) match exactly the API we defined.
  _redis = new UpstashRedis({ url, token }) as unknown as RedisLike;
  return _redis;
}

export function requireRedis(): RedisLike {
  const r = getRedis();
  if (!r) {
    throw new Error(
      useLocal()
        ? "Redis not configured (missing REDIS_HOST / REDIS_PASSWORD)"
        : "Redis not configured (missing UPSTASH_REDIS_REST_URL / _TOKEN)",
    );
  }
  return r;
}

// ── ioredis → RedisLike adapter ────────────────────────────────────────────

function ioredisAdapter(client: IoRedis): RedisLike {
  // Upstash auto-parses values that look like JSON. Mimic that so callers
  // don't have to JSON.parse manually on the local path.
  function tryParse<T>(raw: string): T {
    const c = raw[0];
    if (c === "{" || c === "[" || c === '"' || c === "t" || c === "f" || c === "n" || (c >= "0" && c <= "9") || c === "-") {
      try { return JSON.parse(raw) as T; } catch { /* fall through */ }
    }
    return raw as unknown as T;
  }

  function setArgs(opts?: { ex?: number; nx?: boolean }): (string | number)[] {
    const args: (string | number)[] = [];
    if (opts?.ex != null) args.push("EX", opts.ex);
    if (opts?.nx) args.push("NX");
    return args;
  }

  // Mirror Upstash's auto-serialization: strings pass through, everything
  // else gets JSON.stringify so reads via tryParse round-trip cleanly.
  function serializeForSet(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value);
  }

  return {
    async get<T = string>(key: string): Promise<T | null> {
      const raw = await client.get(key);
      if (raw == null) return null;
      return tryParse<T>(raw);
    },

    async set(key, value, opts) {
      const v = serializeForSet(value);
      const extra = setArgs(opts);
      // ioredis's set signature is overloaded; use the variadic form.
      const result = extra.length > 0
        ? await (client.set as unknown as (...a: unknown[]) => Promise<string | null>)(key, v, ...extra)
        : await client.set(key, v);
      return result === "OK" ? "OK" : null;
    },

    incr: (key) => client.incr(key),
    incrby: (key, by) => client.incrby(key, by),
    expire: (key, sec) => client.expire(key, sec),
    hset: (key, fields) => client.hset(key, fields as Record<string, string | number>),
    hget: (key, field) => client.hget(key, field),

    async hgetall<T = Record<string, string>>(key: string): Promise<T | null> {
      const raw = await client.hgetall(key);
      if (!raw || Object.keys(raw).length === 0) return null;
      return raw as unknown as T;
    },

    del: (...keys) => client.del(...keys),

    pipeline(): RedisPipeline {
      const p = client.pipeline();
      const wrap: RedisPipeline = {
        incr(key) { p.incr(key); return wrap; },
        incrby(key, by) { p.incrby(key, by); return wrap; },
        set(key, value, opts) {
          const v = serializeForSet(value);
          const extra = setArgs(opts);
          if (extra.length > 0) {
            (p.set as unknown as (...a: unknown[]) => unknown)(key, v, ...extra);
          } else {
            p.set(key, v);
          }
          return wrap;
        },
        expire(key, sec) { p.expire(key, sec); return wrap; },
        async exec() {
          const result = await p.exec();
          if (!result) return [];
          // ioredis: [[err, value], ...] → unwrap to [value, ...] like Upstash.
          // Throw on the first per-command error so callers' try/catch fires
          // instead of silently getting an Error object as a "result".
          return result.map(([err, value]) => {
            if (err) throw err;
            return value;
          });
        },
      };
      return wrap;
    },
  };
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
