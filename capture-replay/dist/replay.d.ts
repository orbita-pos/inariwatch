/**
 * Replay V2 — continuous DOM event streaming to InariWatch cloud.
 *
 * Captures full rrweb event stream (not just filtered subset like session.ts),
 * batches into 30-second blocks, and POSTs to /api/replay/ingest. Each block
 * is stored as a gzipped object in Cloudflare R2 and can be scrubbed frame-by-frame
 * in the dashboard player.
 *
 * Browser-only. rrweb is loaded dynamically (optional peer dep) so Node users
 * pay zero bundle cost.
 *
 * Correlation with backend: exposes window.__INARIWATCH_SESSION__ and patches
 * fetch() to propagate the session id as `x-inariwatch-session` header on
 * same-origin requests. The server attaches that id to any errors it captures.
 */
import type { CaptureConfig } from "@inariwatch/capture";
/**
 * Replay recording options. Lives here (not in core capture) so users who
 * only need error tracking pay zero tokens for the type.
 */
export interface ReplayConfig {
    /** Flush interval in seconds (default: 30) */
    blockDurationSec?: number;
    /** Max buffer bytes before forced flush (default: 262144 = 256 KB) */
    maxBufferBytes?: number;
    /** Override the endpoint (default: parsed from DSN or https://app.inariwatch.com) */
    endpoint?: string;
    /**
     * Mask all input values. Default behavior:
     *   - `true`  when `piiClassifier` is `false` — safer fallback.
     *   - `false` when `piiClassifier` is `"heuristic"` or `"ai"` — the classifier decides per field.
     * Explicitly setting this overrides both defaults.
     */
    maskAllInputs?: boolean;
    /** CSS selectors whose text content should be redacted */
    redactSelectors?: string[];
    /**
     * PII classifier strategy:
     *   - `"ai"` (default) — heuristics first, server AI for ambiguous fields.
     *   - `"heuristic"` — client-side rules only, zero network cost.
     *   - `false` — disabled; falls back to `maskAllInputs: true` for safety.
     */
    piiClassifier?: "ai" | "heuristic" | false;
    /**
     * Probability (0.0–1.0) that an uncaught error triggers a full session
     * flush. Default `1.0` — every error session is recorded.
     *
     * Sessions without errors stay 100% client-side (ring buffer only) and
     * never touch the network — matches Sentry's cost-efficient default.
     */
    errorSampleRate?: number;
    /**
     * Probability (0.0–1.0) that a session starts recording from the first
     * event, regardless of whether an error occurs. Default `0.0` — zero
     * passive traffic. Raise to e.g. `0.01` to sample 1% of all sessions for
     * UX research on top of error-triggered capture.
     */
    sessionSampleRate?: number;
    /**
     * Seconds of pre-error context to keep in the client-side ring buffer.
     * When an error fires, the full buffer flushes as the first block so
     * reviewers can see the steps that led to the crash. Default `60`.
     *
     * Also drives rrweb's `checkoutEveryNms` so a full DOM snapshot is
     * guaranteed within every buffer window — without this, trimming old
     * events would leave the replay unplayable.
     */
    bufferSeconds?: number;
}
/** Get current session id (null if replay not active). Exposed for tests. */
export declare function getSessionId(): string | null;
/**
 * Initialize replay recording. Browser-only, no-ops in Node. Idempotent
 * (second call is ignored). Never throws — all errors are logged in debug mode.
 */
export declare function initReplay(replayConfig: ReplayConfig, captureConfig: CaptureConfig): Promise<void>;
declare function estimateSize(event: unknown): number;
/** For tests: reset module state. Not exported from index.ts. */
export declare function __resetForTests(): void;
/** Expose estimator for unit tests. */
export { estimateSize as __estimateSize };
//# sourceMappingURL=replay.d.ts.map