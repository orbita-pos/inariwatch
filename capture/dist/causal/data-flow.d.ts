/**
 * Data-flow taint tracking — SKYNET §3 piece 7 (Track B), session 2.
 *
 * The causal graph already carries `causal` (parent→child) and `temporal`
 * (sibling order) edges. The third edge kind, `data-flow`, is what makes the
 * AI useful for localization: it answers "the value that crashed this query —
 * where did it come from?".
 *
 * Mechanism:
 *   - Every instrumented op that produces a value (HTTP response, Redis GET,
 *     SQL row) calls `tagValue(value, fromNodeId)`. We store the linkage in
 *     a WeakMap so the GC can reclaim values whenever the user drops them —
 *     no leak, no manual cleanup.
 *   - JSON.parse is patched (opt-in via the same causal flag) so that a
 *     response body parsed within a short window after an HTTP call inherits
 *     the request's node id. This covers the `JSON.parse(response.body)`
 *     idiom without forcing the user to instrument anything.
 *   - DB hooks call `findDataFromIds(args)` before recording their op. Any
 *     match becomes a `data-flow` edge into the new DB node.
 *
 * WeakMap keys must be objects, so primitives (strings, numbers) cannot be
 * tagged directly. The HTTP hook tags the parsed body root; downstream DB
 * calls get matched if they pass the parsed body or any of its top-level
 * children. Two-level walk catches `prisma.user.findUnique({ where: { id } })`
 * where `id` itself is a primitive but `where` is the object holding it.
 */
/** Tag a value as produced by a graph node. Primitive values are ignored. */
export declare function tagValue(value: unknown, fromNodeId: string): void;
/** Lookup a single value's provenance node id, or null. */
export declare function getProvenance(value: unknown): string | null;
/**
 * Walk DB query args two levels deep to find tagged objects. Two levels is
 * enough for `prisma.user.findUnique({ where: { id } })` and `pg.query("...",
 * [responseBody.id])` — the most common idioms — without quadratic walks
 * over deeply nested objects.
 */
export declare function findDataFromIds(args: unknown[] | unknown): string[];
/**
 * Mark the next JSON.parse call (within a short window) to tag its result
 * with `fromNodeId`. Called by HTTP hooks when the response trailer arrives —
 * the user's parse of the body inherits the http node as data source.
 */
export declare function markPendingHttpProvenance(fromNodeId: string): void;
/**
 * Patch global JSON.parse to tag results when a pending provenance is set.
 * Idempotent and safe — falls back to native parse for non-string inputs.
 */
export declare function installJsonParseTaint(): void;
/** Test seam — restore native JSON.parse and clear pending state. */
export declare function __resetDataFlowForTesting(): void;
export declare function __getPendingForTesting(): string | null;
//# sourceMappingURL=data-flow.d.ts.map