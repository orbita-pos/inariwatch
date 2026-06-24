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
import { type RedactConfig, resolveRedactConfig } from "./config.js";
export { resolveRedactConfig, type RedactConfig };
/**
 * Apply redaction to a payload object. Returns the redacted payload as a
 * new object — does NOT mutate the input. When the redactor performed
 * any work (regardless of whether anything matched), the result has
 * `_meta.redact_applied = true` so downstream consumers know the event
 * was scrubbed.
 */
export declare function redactPayload<T>(payload: T, config?: RedactConfig): T;
export type { Pattern } from "./patterns.js";
//# sourceMappingURL=index.d.ts.map