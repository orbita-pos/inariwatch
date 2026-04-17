/**
 * Redact sensitive fields from Substrate events before they leave the
 * worker and land in `whatif_replays.result` (JSONB, no TTL on the hot
 * path). The SDK has an agent-side redactor (`agent/lib/redact.js`)
 * that SHOULD have already scrubbed most secrets at record time, but
 * we can't trust that — older SDK versions exist, custom recorders
 * exist, and relying on a single layer is fragile. So we scrub again
 * server-side on the What-If path.
 *
 * What we scrub:
 *   - HTTP headers whose name matches the denylist (authorization,
 *     cookie, set-cookie, x-api-key, etc). Value replaced with `***`.
 *   - Response body_b64 on responses with `set-cookie` present
 *     (session payloads often echo the cookie into the body)
 *   - DB query params that look like opaque tokens (JWT shape,
 *     sufficiently long base64/hex). Heuristic — tolerates false
 *     positives because we don't NEED the param values in the UI,
 *     only in aggregate.
 *
 * What we do NOT scrub:
 *   - HTTP request/response BODIES in the general case. Body
 *     scrubbing requires content-type aware JSON walking + a
 *     property-name denylist; deferred as a follow-up. The header
 *     scrubbing alone catches the most damaging leak path (session
 *     tokens in Authorization + Cookie + Set-Cookie).
 *   - Query strings in HTTP URLs — same reason; URL-param scrubbing
 *     is a separate pass.
 *
 * Pure function — no I/O, no allocations beyond shallow clones of the
 * affected nodes. Events that don't touch the denylist pass through
 * by reference.
 */

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "api-key",
  "x-access-token",
  "x-inariwatch-key",
  "x-forwarded-authorization",
]);

const REDACTED = "***";

/**
 * Heuristic: does this string look like an opaque secret token?
 * JWTs, GitHub PATs, sufficiently long hex/base64. Catches DB params
 * that carry API keys (`SELECT ... WHERE token = ?, params: ["gho_xxx"]`).
 */
function looksLikeToken(s: string): boolean {
  if (s.length < 20) return false;
  // JWT: three base64url segments separated by dots
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return true;
  // GitHub PATs
  if (/^(github_pat_|gh[pousr]_)/.test(s)) return true;
  // Bearer-ish: long opaque blob (base64 with no whitespace)
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(s) && !/\s/.test(s)) return true;
  return false;
}

type EventLike = {
  kind?: Record<string, unknown>;
  [k: string]: unknown;
};

function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

function redactDbParams(params: unknown): unknown {
  if (!Array.isArray(params)) return params;
  return params.map((p) => {
    if (typeof p === "string" && looksLikeToken(p)) return REDACTED;
    return p;
  });
}

function redactEventKind(kind: Record<string, unknown>): Record<string, unknown> {
  const type = kind.type;
  if (type !== "http_request" && type !== "http_response" && type !== "db_query") {
    return kind;
  }

  const clone = { ...kind };

  if (type === "http_request" || type === "http_response") {
    if ("headers" in clone) clone.headers = redactHeaders(clone.headers);
  }

  if (type === "db_query") {
    if ("params" in clone) clone.params = redactDbParams(clone.params);
  }

  return clone;
}

/**
 * Redact a list of events, preserving order and structure. Returns a
 * new array — callers can safely forward without touching the input.
 */
export function redactEvents<T extends EventLike>(events: T[] | undefined): T[] | undefined {
  if (!events) return events;
  return events.map((e) => {
    if (!e.kind) return e;
    const redactedKind = redactEventKind(e.kind);
    if (redactedKind === e.kind) return e;
    return { ...e, kind: redactedKind };
  });
}
