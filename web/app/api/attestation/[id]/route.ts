import { NextRequest, NextResponse } from "next/server";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * VAR Q3 — Public EAP Attestation endpoint.
 *
 *   GET /api/attestation/:receipt_id
 *
 * Public read proxy to the EAP server's /chain/:id route. Returns the
 * full receipt chain + cryptographic verification report so any third
 * party can audit an autonomous remediation *without* an InariWatch
 * account. This is the "verifiable forever" claim — every autonomous
 * fix InariWatch merges gets a hex-addressed receipt whose Merkle root
 * + Ed25519 signature chain is reviewable at this endpoint.
 *
 * Design notes:
 *   - No auth. Receipts are content-addressed (the ID IS the hash) so
 *     the URL itself is a capability. An attacker who doesn't know
 *     the ID cannot enumerate; a party who knows it can audit.
 *   - Rate-limited. Crypto proofs can be large (~100-500 KB per chain)
 *     so we cap throughput per client IP.
 *   - Immutable cache headers. A receipt's content cannot change — once
 *     served, CDNs + browsers can cache indefinitely.
 *   - Graceful degradation: when EAP_SERVER_URL is unset (local dev or
 *     pre-deployment state) we return 503 with a clear message so the
 *     UI can render an informational panel instead of a generic error.
 */

/** Receipt ID format (matches EAP server validate_id): 8-64 hex chars. */
const RECEIPT_ID_REGEX = /^[0-9a-f]{8,64}$/i;

/** Cap proxy response size. EAP /chain responses for typical remediations
 *  sit under 200 KB; 1 MB is a comfortable ceiling that blocks abuse. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Proxy timeout — the EAP server is fast (SQLite + in-memory verify) so
 *  if it takes over 5s something is wrong. */
const PROXY_TIMEOUT_MS = 5_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: receiptId } = await params;

  if (!RECEIPT_ID_REGEX.test(receiptId)) {
    return NextResponse.json(
      { error: "receipt_id must be 8-64 hex characters" },
      { status: 400 },
    );
  }

  // Rate limit on client IP — receipts are public but not free.
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // Read env inside the handler so tests can stubEnv per-case and so a
  // runtime env rotation takes effect without a cold-start restart.
  const eapServerUrl = process.env.EAP_SERVER_URL;
  if (!eapServerUrl) {
    // EAP not deployed yet — surface explicitly so the client UI can
    // render a helpful panel instead of a generic error.
    return NextResponse.json(
      {
        error: "EAP attestation server not yet configured for this workspace",
        hint: "EAP_SERVER_URL is unset. Contact support if you need an immediate audit copy of this receipt.",
      },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetchWithLimit(
      `${eapServerUrl.replace(/\/$/, "")}/chain/${encodeURIComponent(receiptId)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: { accept: "application/json" },
      },
      MAX_RESPONSE_BYTES,
    );

    if (upstream.status === 404) {
      return NextResponse.json(
        { error: "receipt not found" },
        { status: 404 },
      );
    }
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "upstream EAP server error" },
        { status: 502 },
      );
    }

    // EAP /chain response shape: { chain: Receipt[], verification: VerifyReport }
    // Proxy it through verbatim; the EAP server already validated everything.
    const body = await upstream.text();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        // Receipts are content-addressed → immutable.
        "cache-control": "public, max-age=31536000, immutable",
        // Public verifiability: allow cross-origin GETs from any auditor tool.
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET",
        // Defense-in-depth: disallow content-sniffing so a malformed
        // response can't execute as HTML.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[attestation] proxy error:", msg);
    // Timeout or network error reaching the upstream — don't leak details.
    const isTimeout = msg.includes("aborted") || msg.includes("timeout");
    return NextResponse.json(
      { error: isTimeout ? "upstream timeout" : "upstream unavailable" },
      { status: 502 },
    );
  }
}

/**
 * Fetch with a hard byte cap on the response body. Protects against a
 * misconfigured / compromised upstream returning an unbounded stream.
 * Reads the stream chunk by chunk; aborts when the size budget is hit.
 */
async function fetchWithLimit(
  url: string,
  init: RequestInit,
  maxBytes: number,
): Promise<Response> {
  const res = await fetch(url, init);
  // Content-Length short-circuit — reject obviously too-large responses
  // before consuming the body.
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`upstream response too large (${declared} > ${maxBytes} bytes)`);
  }
  const reader = res.body?.getReader();
  if (!reader) return res;

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`upstream response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new Response(merged, { status: res.status, headers: res.headers });
}

/** Allow CORS preflight for third-party audit tools. */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "accept",
      "access-control-max-age": "86400",
    },
  });
}
