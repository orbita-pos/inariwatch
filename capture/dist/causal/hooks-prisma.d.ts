/**
 * Prisma driver hook — patches `PrismaClient.prototype._request` to record
 * a causal-graph node for every model call.
 *
 * `_request` is the private internal method that all proxy methods
 * (`prisma.user.findMany()`, `prisma.$transaction(...)`, …) route through
 * in v4-v6. It's not in the public API, so we guard with a typeof check
 * and silently skip if it's missing or renamed in a future major.
 *
 * For users who can't rely on prototype patches (extended clients,
 * Edge runtime, custom engine), the `instrumentPrismaClient(client)`
 * helper installs the same node-recording listener via `$on('query')`
 * — this requires the client to be constructed with `log: ['query']`.
 *
 * Driver missing: install resolves to `false` silently. Never throws.
 */
type ModLoader = () => Promise<any>;
/**
 * Patch `@prisma/client`'s `PrismaClient.prototype._request`. Returns
 * `true` if newly patched, `false` if missing or already patched.
 */
export declare function installPrismaHook(loader?: ModLoader): Promise<boolean>;
/**
 * Manual instrumentation hook. Usage:
 *
 *   const prisma = new PrismaClient({ log: [{ level: "query", emit: "event" }] })
 *   instrumentPrismaClient(prisma)
 *
 * Adds a `$on('query')` listener that records each query as a graph node.
 * Returns `true` on success, `false` if the client refused (missing
 * `$on`, log not configured, etc.).
 */
export declare function instrumentPrismaClient(client: any): boolean;
export declare const __PRISMA_PATCH_MARK_FOR_TESTING: symbol;
export {};
//# sourceMappingURL=hooks-prisma.d.ts.map