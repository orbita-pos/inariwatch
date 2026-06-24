/**
 * Keys whose VALUE should be redacted regardless of content.
 *
 * Matched case-insensitively against object keys. When the key exactly
 * equals one of these (or an HTTP header variant — Authorization/Cookie),
 * the value is replaced wholesale with `[REDACTED_VALUE]` rather than
 * scanning the value text for known patterns.
 *
 * This catches values that don't match any of our content regexes — e.g.
 * `{ password: "hunter2" }` would otherwise look like a normal short word.
 */
export declare const SENSITIVE_KEYS: Set<string>;
//# sourceMappingURL=keys.d.ts.map