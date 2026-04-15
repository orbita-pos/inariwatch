/**
 * Origin allowlist matcher for browser-facing public endpoints
 * (Replay V2 /api/replay/ingest and /api/replay/classify-pii).
 *
 * Behaviour:
 *   - Empty `allowed` array  → allow any Origin (backward compat for projects
 *     that haven't opted in yet).
 *   - Missing / null Origin  → rejected once the list has at least one entry,
 *     so attackers can't just strip the header.
 *   - Populated list         → strict. Exact scheme+host+port match, or one
 *     leading wildcard subdomain per entry (e.g. `https://*.example.com`).
 *
 * THREAT MODEL — what this check does and does NOT protect against:
 *   ✓ Protects against a 3rd-party site loading the SDK with your projectId
 *     and sending browser traffic — the browser enforces Origin and an
 *     attacker cannot forge it without XSS on your own domain.
 *   ✗ Does NOT protect against direct server-to-server calls (curl / proxy
 *     / headless scrapers) that manually set the Origin header. That threat
 *     is covered by the per-project rate limit in the endpoint instead.
 *
 * Pure function — no DOM, no network, no DB. Zero deps so it's safe to import
 * from anywhere and unit-test in isolation.
 */

export interface OriginDecision {
  allowed: boolean;
  /** Short machine-readable reason — useful for telemetry and 403 responses. */
  reason:
    | "no-allowlist"      // list is empty, allow-all fallback
    | "exact-match"       // entry matched exactly
    | "wildcard-match"    // wildcard subdomain entry matched
    | "missing-origin"    // list is set but request had no Origin header
    | "invalid-origin"    // request Origin header couldn't be parsed
    | "not-in-allowlist"; // list is set and no entry matched
}

/**
 * Returns whether `origin` is accepted given a project's allowlist.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowed: readonly string[] | null | undefined,
): OriginDecision {
  const list = Array.isArray(allowed) ? allowed.map((s) => s.trim()).filter(Boolean) : [];

  // Backward compatibility — a project that hasn't set any allowed origins
  // behaves exactly like the pre-0048 codebase. This is what keeps existing
  // customers from breaking the second this column ships.
  if (list.length === 0) {
    return { allowed: true, reason: "no-allowlist" };
  }

  if (!origin) {
    return { allowed: false, reason: "missing-origin" };
  }

  const req = normalizeOrigin(origin);
  if (!req) {
    return { allowed: false, reason: "invalid-origin" };
  }

  for (const entry of list) {
    if (matchEntry(entry, req)) {
      return { allowed: true, reason: entry.includes("*") ? "wildcard-match" : "exact-match" };
    }
  }

  return { allowed: false, reason: "not-in-allowlist" };
}

interface NormalizedOrigin {
  scheme: string;
  host: string;   // lowercased, IDN not handled
  port: string;   // may be empty
}

/**
 * Normalise an `Origin` header or allowlist entry to `{scheme, host, port}`.
 * Returns null if the string can't be parsed. Both `https://foo.com:443`
 * and `https://foo.com` normalise identically (default-port collapse).
 */
function normalizeOrigin(raw: string): NormalizedOrigin | null {
  try {
    // URL() rejects strings without a scheme, which is what we want — Origin
    // headers always carry a scheme (CORS spec).
    const u = new URL(raw);
    const scheme = u.protocol.replace(":", "").toLowerCase();
    // Strip the trailing dot that denotes a fully-qualified domain name
    // (`example.com.` is equivalent to `example.com` in DNS). Without this
    // an attacker can send Origin: https://example.com. and bypass an
    // entry stored as https://example.com.
    let host = u.hostname.toLowerCase();
    if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
    let port = u.port;
    // Collapse well-known default ports so `https://foo.com` and
    // `https://foo.com:443` are treated as equal.
    if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) {
      port = "";
    }
    if (!scheme || !host) return null;
    return { scheme, host, port };
  } catch {
    return null;
  }
}

/**
 * Match a single allowlist entry against a normalised request origin.
 * Wildcard rule: exactly one `*.` at the start of the host is allowed and
 * matches any single-or-multi-label subdomain (so `*.example.com` matches
 * both `api.example.com` and `api.staging.example.com`). The base domain
 * itself (`example.com`) is NOT matched by `*.example.com` — add a separate
 * entry if the root is also in-use.
 */
function matchEntry(entry: string, req: NormalizedOrigin): boolean {
  // Split off the host to inspect wildcard before handing to URL()
  let wildcard = false;
  let entryForUrl = entry;
  try {
    const schemeEnd = entry.indexOf("://");
    if (schemeEnd < 0) return false;
    const hostStart = schemeEnd + 3;
    const hostEnd = findHostEnd(entry, hostStart);
    const host = entry.slice(hostStart, hostEnd);
    if (host.startsWith("*.")) {
      wildcard = true;
      // Replace the wildcard with a placeholder so URL() can parse it. We'll
      // ignore the placeholder host and compare manually below.
      entryForUrl = entry.slice(0, hostStart) + "wildcard.invalid" + entry.slice(hostEnd);
    }
  } catch {
    return false;
  }

  const parsed = normalizeOrigin(entryForUrl);
  if (!parsed) return false;
  if (parsed.scheme !== req.scheme) return false;
  if (parsed.port !== req.port) return false;

  if (!wildcard) {
    return parsed.host === req.host;
  }

  // Wildcard — `entry` host is `*.<suffix>`; request host must end in `.<suffix>`
  const suffix = getWildcardSuffix(entry);
  if (!suffix) return false;
  return req.host.endsWith(`.${suffix}`) && req.host.length > suffix.length + 1;
}

function findHostEnd(s: string, hostStart: number): number {
  for (let i = hostStart; i < s.length; i++) {
    const c = s[i];
    if (c === "/" || c === ":" || c === "?" || c === "#") return i;
  }
  return s.length;
}

function getWildcardSuffix(entry: string): string | null {
  const schemeEnd = entry.indexOf("://");
  if (schemeEnd < 0) return null;
  const hostStart = schemeEnd + 3;
  const hostEnd = findHostEnd(entry, hostStart);
  const host = entry.slice(hostStart, hostEnd);
  if (!host.startsWith("*.")) return null;
  const suffix = host.slice(2).toLowerCase();
  if (!suffix.includes(".")) return null; // `*.com` would be absurdly permissive
  return suffix;
}

/**
 * Light validation for allowlist entries entered by the user in the UI.
 * Returns an error message if the entry is malformed, or null when it's OK.
 * Kept separate from isOriginAllowed so the UI can reject bad input up front.
 */
export function validateAllowedOriginEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return "Empty value";
  if (trimmed.length > 253) return "Value is too long";
  if (trimmed.includes(" ")) return "Whitespace not allowed";
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return "Must start with http:// or https://";
  }
  // Wildcard rule: at most one leading `*.` and nothing else
  const wildcards = (trimmed.match(/\*/g) ?? []).length;
  if (wildcards > 1) return "Only one wildcard (*.) allowed per entry";
  if (wildcards === 1) {
    const schemeEnd = trimmed.indexOf("://");
    const hostStart = schemeEnd + 3;
    if (!trimmed.slice(hostStart).startsWith("*.")) {
      return "Wildcard must be at the start of the host (e.g. https://*.example.com)";
    }
    if (!getWildcardSuffix(trimmed)) {
      return "Wildcard suffix is too broad (e.g. *.com)";
    }
  }
  // Reject anything after the host — path/query/fragment make no sense in an
  // Origin check.
  try {
    const probe = trimmed.replace("*.", "wildcard.");
    const u = new URL(probe);
    if (u.pathname !== "/" && u.pathname !== "") return "Path not allowed (use host only)";
    if (u.search) return "Query string not allowed";
    if (u.hash) return "Fragment not allowed";
    if (!u.hostname) return "Missing host";
  } catch {
    return "Malformed URL";
  }
  return null;
}
