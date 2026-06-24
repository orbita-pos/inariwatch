/**
 * Pure helpers for safely capturing fetch request / response bodies in the
 * replay stream. Designed so 100% of the masking logic is unit-testable
 * with no DOM / no network — `replay.ts` only orchestrates timing and
 * fetch interception.
 *
 * Threat model:
 *   - Auth tokens, passwords, credit cards, SSNs, secret API keys end up in
 *     real-world bodies all the time. Default policy is "capture nothing"
 *     (project must opt-in) AND "even when on, redact aggressively".
 *   - We never trust customer-shipped denylist patterns to be exhaustive;
 *     the BUILT-IN denylists below always apply on top.
 */
/** Hard ceiling regardless of project setting — defends storage + R2 cost. */
export declare const ABSOLUTE_MAX_BODY_BYTES = 500000;
/**
 * Returns true when the URL matches any built-in or customer-supplied
 * denylist pattern. Used by `captureBodyForUrl` AND surfaced separately
 * so the `_kind: "network"` event can record `bodyOmittedReason`.
 */
export declare function urlIsDenied(url: string, customerPatterns?: string[]): boolean;
/** True when the content type is in the allowlist (text-ish formats only). */
export declare function contentTypeIsCapturable(contentType: string | null | undefined): boolean;
/**
 * Mask values whose key looks like a secret. Recurses into objects/arrays.
 * Strings replaced with `[REDACTED]`. Used on request + response bodies
 * after JSON parsing.
 *
 * Non-JSON bodies skip this step (we only mask structured data — text/xml
 * pass through unchanged once they pass the size + URL gates).
 */
export declare function maskSecretsInJson(value: unknown, depth?: number): unknown;
/**
 * Filter out auth-related headers, return the rest as a flat record.
 * Header values themselves are not modified — the assumption is once the
 * NAME isn't sensitive, the value isn't either (cache-control, content-type).
 */
export declare function redactHeaders(headers: Record<string, string>): Record<string, string>;
/**
 * Process a captured raw body string into the final shape stored on the
 * `_kind: "network"` event. Returns null when the body should NOT be
 * captured (denied URL, wrong content type, oversized after truncation).
 *
 * Truncation strategy: if the raw body exceeds `maxBytes`, slice and
 * append a marker so the reviewer can tell. JSON bodies are pretty-printed
 * AFTER masking so the viewer is human-readable.
 */
export interface ProcessedBody {
    /** UTF-8 string ready to ship. May be valid JSON or any other text. */
    text: string;
    /** True when the original body was longer than maxBytes. */
    truncated: boolean;
    /** Original size in bytes (pre-truncation) — useful in the UI. */
    originalBytes: number;
}
export declare function processBody(opts: {
    raw: string;
    contentType: string | null;
    maxBytes: number;
}): ProcessedBody | null;
//# sourceMappingURL=network-body.d.ts.map