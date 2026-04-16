/**
 * PII scrubber for anything stored long-term (AI prompts, community-contributed
 * fixes, error logs). Designed to fail-safe: a false positive (over-scrubbing)
 * is always better than a leak.
 *
 * Patterns are ordered by specificity — longest/most-unique-prefix first so
 * we don't accidentally mask a prefix of a more specific token.
 */

interface ScrubOptions {
  maxChars?: number;
}

const PATTERNS: { name: string; re: RegExp; replacement: string }[] = [
  // Auth headers (order matters — Bearer before generic JWT)
  { name: "bearer",      re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,                    replacement: "Bearer [REDACTED]" },
  { name: "basic-auth",  re: /Basic\s+[A-Za-z0-9+/=]{10,}/gi,                         replacement: "Basic [REDACTED]" },

  // Platform-specific API keys — anthropic BEFORE openai because `sk-ant-`
  // is a more specific prefix than `sk-` and the openai regex would eat it.
  { name: "anthropic",   re: /sk-ant-[A-Za-z0-9_-]{20,}/g,                            replacement: "[anthropic-key]" },
  { name: "openai",      re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,                      replacement: "[openai-key]" },
  { name: "stripe",      re: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,          replacement: "[stripe-key]" },
  { name: "github-pat",  re: /gh[pousr]_[A-Za-z0-9]{36,}/g,                           replacement: "[github-pat]" },
  { name: "slack",       re: /xox[baprs]-[A-Za-z0-9-]{10,}/g,                         replacement: "[slack-token]" },
  { name: "aws-access",  re: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,                            replacement: "[aws-access-key]" },

  // Generic tokens
  { name: "jwt",         re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[jwt]" },

  // Identifiers
  { name: "email",       re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,       replacement: "[email]" },

  // Credit card-ish (Luhn not validated — best effort)
  { name: "cc",          re: /\b(?:\d[ -]?){13,19}\b/g,                               replacement: "[cc]" },
];

/**
 * Scrub known PII patterns from a string. Returns the scrubbed string.
 * Truncates after scrubbing if `maxChars` is provided.
 *
 * @example
 *   scrub("User test@foo.com with Bearer abc123...token")
 *   → "User [email] with Bearer [REDACTED]"
 */
export function scrub(input: string | null | undefined, opts: ScrubOptions = {}): string | null {
  if (!input) return null;
  let out = input;
  for (const p of PATTERNS) out = out.replace(p.re, p.replacement);
  if (opts.maxChars && out.length > opts.maxChars) {
    return out.slice(0, opts.maxChars) + `\n\n[truncated — ${out.length - opts.maxChars} more chars]`;
  }
  return out;
}

/** Export patterns for testing and reuse. */
export const PII_PATTERNS = PATTERNS;
