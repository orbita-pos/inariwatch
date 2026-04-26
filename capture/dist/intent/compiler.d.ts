/**
 * Intent contracts compiler — orchestrator (SKYNET §3 piece 5, Track D).
 *
 * Public API: `extractIntentForFrame({ file, line, function })`.
 *
 * Pipeline:
 *   1. resolve frame → (file, symbol)              ← `resolver.ts` logic inlined
 *   2. cache lookup keyed by (file mtime, commit)  ← skip work on hot paths
 *   3. for each registered source:                 ← `sources/typescript`, `sources/zod`
 *        if `canParse(file)` and `extract` returns a shape, wrap in
 *        `IntentContract` and add to the result list
 *   4. cap output at MAX_SHAPE_BYTES per contract
 *   5. write back to cache
 *
 * Sources are best-effort; one source returning `null` doesn't stop the
 * others. Multiple sources can emit for the same file (e.g. a handler
 * with both a TS-typed param AND a Zod validator inside) — the LLM gets
 * both contracts.
 *
 * Cache stats are exposed for the acceptance test (>90% hit ratio on
 * subsequent runs). See `__getCacheStats`.
 */
import type { IntentContract } from "../types.js";
import type { IntentSource } from "./types.js";
export interface ResolverFrame {
    /** Absolute or repo-relative file path. */
    file: string;
    /** 1-based line number inside the file. */
    line: number;
    /** Function or method name as it appears in the stack frame. Optional. */
    function?: string;
}
export interface ExtractOptions {
    /** Override the default source list. Useful for tests / future polyglot fan-out. */
    sources?: IntentSource[];
    /**
     * Commit SHA for cache keying — typically `process.env.GIT_COMMIT` or
     * `process.env.VERCEL_GIT_COMMIT_SHA`. When present we include it in the
     * cache key so a deploy that changed the file invalidates instantly,
     * even if mtime didn't move (e.g. CI build with reset timestamps).
     */
    commitSha?: string;
    /** Skip cache entirely. Tests and one-shot CLI runs use this. */
    bypassCache?: boolean;
}
export declare const DEFAULT_SOURCES: IntentSource[];
/**
 * Main entry. Returns 0+ contracts for the frame. Never throws — every
 * failure mode degrades to `[]`.
 *
 * Cost: hot path (cached) is one stat() call + Map lookup. Cold path is
 * a single TS parse per source per file (~20-50ms for typical handler
 * files; we cache the result by mtime so it's amortized to ~0).
 */
export declare function extractIntentForFrame(frame: ResolverFrame, options?: ExtractOptions): IntentContract[];
export declare function __resetCacheForTesting(): void;
export declare function __getCacheStats(): {
    hits: number;
    misses: number;
    size: number;
};
export declare function __cacheHitRatio(): number;
//# sourceMappingURL=compiler.d.ts.map