/**
 * Drizzle ORM hook — patches the `execute` method on the dialect-specific
 * Database prototypes (`PgDatabase`, `MySqlDatabase`, `BaseSQLiteDatabase`).
 *
 * Drizzle is structured as a thin wrapper over a driver (pg, postgres-js,
 * mysql2, better-sqlite3, …). Every query — whether built via `db.select(...)`
 * or `db.execute(sql\`...\`)` — funnels through the dialect's
 * `Database.prototype.execute`. Patching there gets us full coverage with
 * a single hook per dialect.
 *
 * We try each `*-core` package independently — if a project uses only
 * `pg-core`, it has no `mysql-core` and we skip that dialect quietly.
 *
 * Idempotent and zero-throw on missing modules.
 */
type ModLoader = () => Promise<any>;
interface DrizzleLoaders {
    pg?: ModLoader;
    mysql?: ModLoader;
    sqlite?: ModLoader;
}
/**
 * Patch every available drizzle dialect's `Database.prototype.execute`.
 * Returns `true` if at least one prototype was newly patched.
 */
export declare function installDrizzleHook(loaders?: DrizzleLoaders): Promise<boolean>;
export declare const __DRIZZLE_PATCH_MARK_FOR_TESTING: symbol;
export {};
//# sourceMappingURL=hooks-drizzle.d.ts.map