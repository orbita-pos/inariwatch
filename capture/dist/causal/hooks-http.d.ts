/**
 * HTTP outbound hook — SKYNET §3 piece 7 (Track B), session 2.
 *
 * Two strategies, picked per environment:
 *
 *   - Node ≥18 (and Bun): subscribe to undici's diagnostics_channel events.
 *     Node's native `fetch` is undici under the hood, so this single hook
 *     covers `fetch`, `node-fetch` (npm), and direct undici callers in one
 *     pass — without monkey-patching globals.
 *
 *   - Browser: monkey-patch `window.fetch`. PerformanceObserver gives us
 *     timing but not the request/response object pair we need to inject
 *     stitching headers and tag the parsed body.
 *
 * Stitching:
 *   - On every outbound request we inject `X-IW-Session-Id` (from FullTrace)
 *     and `X-IW-Causal-Id` (the active node id). Downstream services running
 *     this SDK pick those up and link their nodes to the same chain.
 *   - On response, we look for `X-IW-Subgraph` — a base64-encoded
 *     `CausalGraph` from the downstream service — and merge it into the
 *     local buffer with a causal edge from the http node to the foreign
 *     root. That's what produces the cross-service unified graph.
 *
 * Data-flow:
 *   - On response trailer, mark a short pending-provenance window so the
 *     user's next `JSON.parse(responseBody)` tags the parsed value with the
 *     http node id. Downstream DB hooks then add `data-flow` edges if that
 *     value (or one level below it) is passed to a query.
 *
 * Browser/Edge runtime: undici diagnostics_channel doesn't exist in the
 * browser, so install resolves to `false`. A `installBrowserHttpHook`
 * export is provided for browser callers; it monkey-patches global `fetch`
 * and is wired by the browser entry, not the node `installAllHooks`.
 *
 * Cap: each request adds at most 2 nodes (request + response) — the cap in
 * graph.ts handles overflow naturally.
 */
/**
 * Install the undici diagnostics_channel hook. Idempotent. Returns true
 * when the channel was newly subscribed, false when undici/diagnostics
 * channel is unavailable or we've already installed.
 *
 * `loader` is a test seam — production passes `undefined` and we resolve
 * `node:diagnostics_channel` ourselves.
 */
export declare function installHttpHook(loader?: () => Promise<unknown>): Promise<boolean>;
/**
 * Install the browser fetch hook. Adds a wrapper around `globalThis.fetch`
 * that records http.<method> nodes, injects stitching headers, and merges
 * the X-IW-Subgraph response header into the active causal buffer.
 *
 * Browser-only. Returns true when newly installed.
 */
export declare function installBrowserHttpHook(): boolean;
export declare function __resetHttpHookForTesting(): void;
export declare const __HTTP_PATCH_MARK_FOR_TESTING: symbol;
export declare const __HTTP_HEADERS: {
    SESSION: string;
    CAUSAL: string;
    SUBGRAPH: string;
};
//# sourceMappingURL=hooks-http.d.ts.map