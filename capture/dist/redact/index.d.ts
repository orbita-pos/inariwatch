/**
 * In-process PII / secret redactor for `@inariwatch/capture` Node SDK.
 *
 * Goal: scrub user-side payloads BEFORE they leave the user's process,
 * so the InariWatch cloud never sees emails, phone numbers, credit
 * cards, JWTs, API keys, etc. — even by accident in stack traces or
 * breadcrumb context.
 *
 * Design constraints (per v0.3 S6 + `feedback_no_proprietary_ai.md`):
 *   - Regex-based and synchronous. NO ML model, NO ONNX runtime, NO
 *     extra deps. The SDK stays zero-dep.
 *   - Deterministic + auditable: every redacted slot is tagged with the
 *     pattern label so support can answer "what was scrubbed here?"
 *     without ever seeing the original.
 *   - Hot-path safe: target <5ms p95 for a 5KB payload.
 *
 * Activation: `Capture.init({ redact: true })` or
 *             `Capture.init({ redact: { allowlist: [...] } })`.
 *
 * The redactor runs at the very end of the send pipeline (after all
 * integration `onBeforeSend` hooks and the user's `beforeSend`), so it
 * sees the final wire payload. When it runs, it tags
 * `payload._meta.redact_applied = true` so the server can flag the
 * event as scrubbed and skip enrichment paths that would re-derive PII.
 */
import { type Pattern } from "./patterns.js";
export interface RedactConfig {
    /**
     * Master switch. When `Capture.init({ redact: true })` is used, this is
     * set to `true`. When `redact: false` or unset, the redactor never runs.
     */
    enabled?: boolean;
    /**
     * Additional patterns appended to the default set. Use to scrub
     * project-specific identifiers (employee IDs, internal account
     * numbers, license keys, etc.).
     */
    customPatterns?: Pattern[];
    /**
     * Dot-path keys to skip even if their value matches a pattern.
     * Example: `["request.headers.user-agent", "env.node"]`.
     *
     * Path comparison is case-sensitive against the canonical key chain
     * built during traversal — for HTTP header objects the key is whatever
     * the consumer set, typically lowercased.
     */
    allowlist?: string[];
    /**
     * When true, replacements include an FNV-1a hash of the original
     * value: `[REDACTED_EMAIL:a1b2c3d4]`. Lets engineers correlate the
     * same redacted value across events without ever exposing the
     * original. Default: false (just `[REDACTED_EMAIL]`).
     */
    hashMode?: boolean;
    /**
     * Redact IPv4 addresses. Default: false. Many users want IPs visible
     * for debugging routing / rate-limiting / abuse cases. Flip on if your
     * compliance posture requires IP scrubbing.
     */
    redactIPs?: boolean;
    /**
     * Detect 40-char [A-Za-z0-9/+] runs as AWS secrets. Default: false —
     * the shape collides with base64 blobs and long file paths, producing
     * false positives in normal logs. The `aws_secret_access_key` key path
     * is always scrubbed regardless of this flag (via SENSITIVE_KEYS).
     */
    redactAwsSecrets?: boolean;
    /**
     * Hard recursion depth limit. Default: 32. Prevents pathological
     * nested objects (or accidental cycles, though we also use a WeakSet
     * cycle guard) from blowing the stack.
     */
    maxDepth?: number;
}
/**
 * Apply redaction to a payload object. Returns the redacted payload as a
 * new object — does NOT mutate the input. When the redactor performed
 * any work (regardless of whether anything matched), the result has
 * `_meta.redact_applied = true` so downstream consumers know the event
 * was scrubbed.
 */
export declare function redactPayload<T>(payload: T, config?: RedactConfig): T;
/**
 * Coerce the user-provided `redact` config (boolean | partial object)
 * into a `RedactConfig` with `enabled` set. Used by `init()` to keep the
 * caller-facing API simple (`redact: true`).
 */
export declare function resolveRedactConfig(raw: boolean | Partial<RedactConfig> | undefined): RedactConfig;
export type { Pattern } from "./patterns.js";
//# sourceMappingURL=index.d.ts.map