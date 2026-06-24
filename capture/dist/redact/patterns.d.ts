/**
 * Regex bank for in-process PII / secret redaction.
 *
 * Each entry describes WHAT it matches and WHAT label replaces a match.
 * Patterns must be `g` (global) — the redactor relies on `String#replace`
 * with a global regex to scrub every occurrence in one pass.
 *
 * False-positive notes (per S6 design):
 *   - IPv4 detection is opt-in (`redactIPs` flag) — many users want IPs
 *     visible for debugging.
 *   - AWS secret detection is opt-in (`redactAwsSecrets` flag) — the 40-char
 *     [A-Za-z0-9/+] shape collides with base64 blobs and long file paths.
 *
 * NEW patterns must keep the `g` flag and a stable label so server-side
 * dedup of redacted events doesn't churn.
 */
export interface Pattern {
    /** Stable label used both for `[REDACTED_<LABEL>]` and the hash-mode form. */
    label: string;
    /** Regex (must have `g` flag). */
    regex: RegExp;
    /**
     * Optional post-match validator. Returning `false` skips this match
     * (no replacement). Lets us pair a coarse regex with semantic checks
     * like Luhn for credit cards.
     */
    validate?: (match: string) => boolean;
}
/**
 * Default pattern set — applied unless a `customPatterns` override is given.
 *
 * Order matters: more specific patterns run first so a stripe key isn't
 * also matched as a generic secret-shaped string.
 */
export declare const DEFAULT_PATTERNS: Pattern[];
/**
 * Optional patterns — opt-in via RedactConfig flags.
 */
export declare const IPV4_PATTERN: Pattern;
/**
 * AWS secret shape: 40 chars [A-Za-z0-9/+]. Caller must provide a
 * context-aware validator that only redacts when the surrounding text
 * mentions "secret"/"key"/"token" — bare 40-char base64 runs are very
 * common in unrelated log lines.
 */
export declare const AWS_SECRET_PATTERN: Pattern;
//# sourceMappingURL=patterns.d.ts.map