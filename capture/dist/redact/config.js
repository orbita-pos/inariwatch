/**
 * Tiny, static-import-safe slice of the redact module.
 *
 * Why this file exists: `init()` needs to translate the user's
 * `redact: true | { ... }` config into a normalized `RedactConfig` at
 * startup. The full redactor (`redactPayload` + patterns + Luhn + FNV)
 * weighs ~7 KB minified and is only needed at *send* time, and only
 * when redaction is actually enabled.
 *
 * Splitting `resolveRedactConfig` here lets `client.ts` static-import
 * just the config normalizer, then dynamic-import the heavy
 * `redactPayload` inside `sendWithHooks` only when
 * `resolvedRedactConfig.enabled === true`. That trims ~3 KB gzipped
 * from the default initial bundle for users who don't opt into
 * redaction — the 90% case.
 *
 * The full `redact/index.ts` re-exports `RedactConfig` and
 * `resolveRedactConfig` from here so the public API stays unchanged.
 * Anyone importing `@inariwatch/capture/redact` (or the symbol via
 * the main entry) sees the same surface they always did.
 *
 * See `docs/decisions/0001-lazy-redact.md` for the full design
 * rationale and latency tradeoffs.
 */
/**
 * Coerce the user-provided `redact` config (boolean | partial object)
 * into a `RedactConfig` with `enabled` set. Used by `init()` to keep
 * the caller-facing API simple (`redact: true`).
 *
 * This is a sub-1 KB function with zero deps on patterns/keys/hash —
 * deliberately small so it can be static-imported into the hot path
 * of `init()` without dragging in the full redactor.
 */
export function resolveRedactConfig(raw) {
    if (raw === true)
        return { enabled: true };
    if (raw === false || raw === undefined)
        return { enabled: false };
    return { enabled: true, ...raw };
}
//# sourceMappingURL=config.js.map