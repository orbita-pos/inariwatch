/**
 * Causal Graph Engine — SKYNET §3 piece 7 (Track B), session 1.
 *
 * Builds a runtime graph of operations the request touched: each
 * instrumented op (DB query, HTTP call, Redis op, …) becomes a Node;
 * relations between ops become Edges. Three edge kinds:
 *
 *   - `causal`     — parent op invoked child op (synchronous or awaited)
 *   - `temporal`   — sibling op ran after another sibling under the same parent
 *   - `data-flow`  — value produced by one op was consumed by another
 *
 * Why this exists: linear breadcrumbs (Sentry's model) lose the structure
 * the AI needs to localize a bug. GALA (arXiv 2508.12472) measures +20pts
 * RCA accuracy when given a causal graph instead of a flat trace. Same
 * shape now enables Track B sessions 2-3 (HTTP/Redis hooks, edge stitching)
 * and Track G (substrate replay edge correlation).
 *
 * Storage: `node:async_hooks.AsyncLocalStorage` carries a per-context
 * `GraphBuffer` so concurrent requests don't fight. Each buffer caps at
 * 200 nodes (FIFO eviction with edge cleanup).
 *
 * Activation: opt-in. The SDK reads `CAPTURE_CAUSAL_GRAPH=1` (or
 * `INARIWATCH_CAUSAL_GRAPH=1`). When the flag is off every API in this
 * file short-circuits to a no-op so the SDK stays free for non-opted-in
 * users.
 *
 * Zero deps. Only Node built-ins (`async_hooks`).
 */
import type { CausalGraph } from "../types.js";
export type EdgeKind = "causal" | "temporal" | "data-flow";
/** Internal node — richer than the wire `CausalGraphNode`. Serialized down at flush time. */
export interface Node {
    id: string;
    op: string;
    ts: number;
    durationMs?: number;
    attrs?: Record<string, unknown>;
}
/** Internal edge — serialized to the frozen wire shape on flush. */
export interface Edge {
    from: string;
    to: string;
    kind: EdgeKind;
}
interface GraphBuffer {
    nodes: Node[];
    edges: Edge[];
    parent: Map<string, string>;
    evictedIds: Set<string>;
    /** id of the most recent child added under each parent (key = parent id, "" for root). */
    lastSibling: Map<string, string>;
}
/**
 * Resolve `node:async_hooks` once and create the AsyncLocalStorage instance.
 *
 * Idempotent — second call is a no-op. Safe to call without checking the
 * flag; if the flag is off we still resolve so a later flag flip during
 * tests works without re-init. Falls back to `null` ALS on browser/Edge —
 * `recordOp` and friends still work via the process-global slot.
 */
export declare function initCausalGraph(): Promise<void>;
/**
 * Run `fn` inside a fresh causal-graph buffer. The SDK calls this around
 * each incoming request (HTTP handler, queue worker) so concurrent
 * requests don't share nodes. If the flag is off or `async_hooks` is
 * unavailable, runs `fn` directly with no overhead.
 */
export declare function runWithRoot<T>(fn: () => T): T;
export interface RecordHandle {
    /** Empty string when the flag is off. Stable id otherwise. */
    id: string;
    /**
     * Mark this op finished. `durationMs` overrides our wall-clock measure
     * (some drivers report their own server-side duration); `dataFrom`
     * stitches data-flow edges from earlier nodes into this one.
     *
     * Idempotent — only the first call has any effect.
     */
    end(extras?: {
        durationMs?: number;
        attrs?: Record<string, unknown>;
        dataFrom?: string[];
        error?: unknown;
    }): void;
}
/**
 * Push a new node into the active buffer with a causal edge to the
 * current parent (if any) and a temporal edge from the previous sibling.
 *
 * Returns a handle whose `end()` restores the previous parent so nested
 * ops form a tree rather than a flat list. If the flag is off this is
 * a single boolean check + a constant-handle return — sub-microsecond.
 */
export declare function recordOp(op: string, attrs?: Record<string, unknown>): RecordHandle;
/** id of the active node on this async chain, or `null` at the root. */
export declare function getCurrentNodeId(): string | null;
/**
 * BFS from `rootId` (or the current node) up the parent chain to depth
 * `maxDepth`, also pulling in adjacent siblings/children up to `maxNodes`.
 *
 * Used at throw-time to attach a focused subgraph to the v2 payload —
 * the AI only needs the chain that led to the failing frame, not the
 * entire request's I/O.
 */
export declare function extractSubgraph(rootId?: string, maxDepth?: number, maxNodes?: number): CausalGraph | undefined;
/** Serialize the entire active buffer into the wire `CausalGraph` shape. */
export declare function serializeForPayload(maxNodes?: number): CausalGraph | undefined;
/**
 * Merge a foreign subgraph (received from a downstream service via response
 * header or a sibling event sharing the same session id) into the active
 * buffer. Each foreign node is namespaced — its id is prefixed with `prefix:`
 * — so it cannot collide with locally generated ids and stays attributable
 * back to its origin in the rendered graph.
 *
 * If `parentId` is given, a `causal` edge is added from the local parent to
 * each foreign root (a foreign node with no inbound edge inside the foreign
 * graph). This is the stitch point that turns "two graphs from two services"
 * into "one graph that crosses a service boundary".
 *
 * Cap policy: total nodes after merge stays ≤ MAX_NODES. If the foreign
 * graph would exceed the cap, the merge truncates from the END of the
 * foreign array (latest foreign nodes are the most relevant — closest to
 * the throw frame in the downstream service).
 */
export declare function mergeSubgraph(foreign: CausalGraph, prefix: string, parentId?: string): {
    merged: number;
    skipped: number;
};
/**
 * Serialize the active buffer to a compact `CausalGraph` and base64-encode
 * it for transport in HTTP headers. Returns null if no graph or > maxBytes.
 *
 * Used by the HTTP outbound hook to attach the downstream service's
 * subgraph to its response, and by handlers to embed in their own response
 * when they want to expose their causal trail to upstream callers.
 */
export declare function serializeForHeader(maxBytes?: number): string | null;
/** Decode a base64 header value into a CausalGraph. Returns null on any failure. */
export declare function deserializeFromHeader(header: string): CausalGraph | null;
export declare function __resetCausalGraphForTesting(): void;
export declare function __getBufferForTesting(): GraphBuffer | null;
export declare function __getCurrentIdForTesting(): string | null;
export declare function __isAlsActiveForTesting(): boolean;
/** Force the flag on for a single test block — restores on return. */
export declare function __withFlagOnForTesting<T>(fn: () => T): T;
export {};
//# sourceMappingURL=graph.d.ts.map