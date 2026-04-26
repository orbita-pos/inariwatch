/**
 * ioredis hook — patches `Redis.prototype.sendCommand` to record a graph
 * node for every Redis command.
 *
 * `sendCommand` is the single funnel for every public method on ioredis
 * (`client.get(key)`, `client.set(key, val)`, `client.pipeline().exec()` —
 * pipelines flush through individual sendCommand calls). Patching it gets
 * full driver coverage with one hook.
 *
 * Idempotent (Symbol mark on the prototype). Driver missing → returns
 * `false` silently. Never throws.
 *
 * The recorded op uses the lowercase command name (`redis.get`, `redis.set`,
 * `redis.hset`, …) so downstream filtering matches the same op-name shape
 * used by pg/prisma/drizzle hooks.
 */
type ModLoader = () => Promise<any>;
/**
 * Patch ioredis `Redis.prototype.sendCommand`. Returns `true` when newly
 * patched, `false` when missing or already patched.
 */
export declare function installRedisHook(loader?: ModLoader): Promise<boolean>;
export declare const __REDIS_PATCH_MARK_FOR_TESTING: symbol;
export {};
//# sourceMappingURL=hooks-redis.d.ts.map