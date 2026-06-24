/**
 * Cross-origin response helpers for browser-facing Replay V2 endpoints
 * (/api/replay/ingest, /api/replay/classify-pii).
 *
 * Both endpoints are called from arbitrary origins (the customer's webapp)
 * so they need CORS headers. We tie the Access-Control-Allow-Origin header
 * to the same per-project allowlist used by isOriginAllowed():
 *   - No allowlist configured → reflect the caller's Origin (like `*`, but
 *     we avoid `*` so cookie-bearing requests stay blocked by the browser).
 *   - Allowlist configured → reflect the Origin only if it matches; otherwise
 *     omit the header so the browser blocks the response.
 */

import { NextResponse } from "next/server";
import { isOriginAllowed } from "./replay-origin";

export function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[] | null | undefined,
): Record<string, string> {
  const decision = isOriginAllowed(origin, allowedOrigins);

  // Omit ACAO entirely when the caller's Origin isn't allowed — the browser
  // will block the response, and the endpoint's 403 body is never exposed to
  // the page's JS (still visible in devtools).
  if (!decision.allowed) return baseHeaders();

  // Reflect the actual origin. We never use `*` because some integrations
  // rely on cookies / credentials, and the spec forbids `*` with credentials.
  return {
    ...baseHeaders(),
    "Access-Control-Allow-Origin": origin ?? "*",
    "Vary": "Origin",
  };
}

function baseHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

/** 204 response for CORS preflight requests. */
export function corsPreflightResponse(
  origin: string | null,
  allowedOrigins: readonly string[] | null | undefined,
): NextResponse {
  return new NextResponse(null, { status: 204, headers: buildCorsHeaders(origin, allowedOrigins) });
}
