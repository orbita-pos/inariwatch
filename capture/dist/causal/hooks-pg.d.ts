/**
 * `pg` driver hook — patches Client.prototype.query and Pool.prototype.query
 * to record a causal-graph node for every query.
 *
 * Both Promise and callback APIs are supported:
 *   client.query("SELECT 1")               → returns Promise → wrap .then
 *   client.query("SELECT 1", [], cb)       → wrap cb to record on completion
 *
 * Idempotent: a second install on the same prototype is a no-op (we mark
 * the prototype with a Symbol). Survives re-imports of `pg` because
 * Node caches modules.
 *
 * Driver missing: install resolves to `false` silently. Never throws.
 *
 * Test seam: `loader` lets tests pass a fake `pg` module. Default loader
 * dynamic-imports the real package.
 */
type ModLoader = () => Promise<any>;
/**
 * Patch `pg`'s `Client.prototype.query` and `Pool.prototype.query`. Returns
 * `true` if at least one prototype was newly patched, `false` otherwise
 * (driver missing or already patched).
 */
export declare function installPgHook(loader?: ModLoader): Promise<boolean>;
export declare const __PG_PATCH_MARK_FOR_TESTING: symbol;
export {};
//# sourceMappingURL=hooks-pg.d.ts.map