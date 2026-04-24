import { NextRequest, NextResponse } from "next/server";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { db } from "@/lib/db";
import { eapReceipts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  isLocalVerifyEnabled,
  verifyAndPersist,
} from "@/lib/services/eap-verify-local";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fase 11 — Public EAP receipt verification endpoint.
 *
 *   GET /api/eap/verify/:receiptId
 *
 * This is the **canonical** public verify endpoint per the remediation
 * architecture (REMEDIATION_SYSTEM_ARCHITECTURE.md §Fase 11). It is a
 * strict superset of the older /api/attestation/:id proxy:
 *
 *   1. Local-first: serves receipt metadata from the `eap_receipts` mirror
 *      table when the receipt is known, avoiding an EAP server round-trip
 *      on the hot path.
 *   2. Upstream fallback: if the mirror doesn't have it (older receipts
 *      pre-Fase 11, or the mirror insert failed), falls back to proxying
 *      the EAP server's /chain/:id and returns the full cryptographic
 *      proof chain.
 *   3. Optional full-chain mode via ?chain=1 — skip the mirror and always
 *      fetch the full proof chain from EAP. Used by auditor tools that
 *      want the full Merkle path, not just the metadata.
 *
 * Response shapes:
 *   - Mirror hit (200):
 *     {
 *       receipt_id: hex,
 *       merkle_root: hex,
 *       signed: bool,
 *       signature: hex|null,
 *       event_count: int,
 *       attestor: string,
 *       created_at: ISO-8601,
 *       source: "local"
 *     }
 *   - Upstream hit (200): passes through EAP /chain response
 *     {
 *       chain: [...],
 *       verification: {...},
 *       source: "upstream"
 *     }
 *
 * Design notes:
 *   - No auth. Receipts are content-addressed (the ID IS the Merkle root)
 *     so the URL itself is a capability. Enumeration is infeasible.
 *   - Rate-limited by IP to prevent abuse — receipts are public but not
 *     free to serve.
 *   - Cache headers allow CDNs + browsers to cache indefinitely (content-
 *     addressed → immutable).
 *   - CORS `*` for GET so third-party audit tools can verify cross-origin.
 *   - No private-key material ever exposed (only public Merkle root + Ed25519
 *     signature + attestor pubkey, which is public by design).
 */

/** Receipt ID format — same as EAP server validate_id: 8-64 hex chars. */
const RECEIPT_ID_REGEX = /^[0-9a-f]{8,64}$/i;

/** Upstream chain responses can be large (~100-500 KB). 1 MB cap. */
const MAX_UPSTREAM_BYTES = 1024 * 1024;

/** EAP server is fast (SQLite + in-memory verify). 5s is generous. */
const PROXY_TIMEOUT_MS = 5_000;

interface MirrorRow {
  receiptId: string;
  merkleRoot: string;
  signature: string | null;
  signed: boolean;
  eventCount: number;
  attestor: string;
  createdAt: Date;
  verified: boolean | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ receiptId: string }> },
): Promise<NextResponse> {
  const { receiptId } = await params;

  if (!RECEIPT_ID_REGEX.test(receiptId)) {
    return jsonWithCors(
      { error: "receipt_id must be 8-64 hex characters" },
      400,
    );
  }

  // Rate limit on client IP — public endpoint, still not free.
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return jsonWithCors({ error: "Too many requests" }, 429, {
      "Retry-After": "60",
    });
  }

  const url = new URL(req.url);
  const wantChain = url.searchParams.get("chain") === "1";
  const receiptIdLc = receiptId.toLowerCase();

  // 1. Local-first (unless ?chain=1 explicitly asks for the full proof).
  if (!wantChain) {
    const mirror = await loadFromMirror(receiptIdLc);
    if (mirror) {
      // Lazy on-first-hit local verify: when the flag is on, the receipt
      // is signed, and verification hasn't been persisted yet, fire-and-
      // forget the verify + persist path. Does NOT block the response —
      // the next request (or the hourly sweep cron) reads the cached
      // verdict from `eap_receipts.verified`. This gives us warmer Gate
      // 6 inputs without adding latency to the hot path.
      if (
        isLocalVerifyEnabled() &&
        mirror.verified === null &&
        mirror.signature !== null
      ) {
        void verifyAndPersist({
          receiptId: mirror.receiptId,
          signatureHex: mirror.signature,
        }).catch((err) => {
          console.error(
            "[eap-verify] on-hit verify failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
      }

      return jsonWithCors(
        {
          receipt_id: mirror.receiptId,
          merkle_root: mirror.merkleRoot,
          signed: mirror.signed,
          signature: mirror.signature,
          event_count: mirror.eventCount,
          attestor: mirror.attestor,
          created_at: mirror.createdAt.toISOString(),
          verified: mirror.verified,
          source: "local" as const,
        },
        200,
        immutableCacheHeaders(),
      );
    }
  }

  // 2. Fallback / chain mode — proxy to EAP server /chain/:id.
  const eapServerUrl = process.env.EAP_SERVER_URL;
  if (!eapServerUrl) {
    return jsonWithCors(
      {
        error: "EAP attestation server not configured",
        hint: "EAP_SERVER_URL is unset. Contact support for an audit copy of this receipt.",
      },
      503,
    );
  }

  try {
    const upstream = await fetchWithLimit(
      `${eapServerUrl.replace(/\/$/, "")}/chain/${encodeURIComponent(receiptIdLc)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: { accept: "application/json" },
      },
      MAX_UPSTREAM_BYTES,
    );

    if (upstream.status === 404) {
      return jsonWithCors({ error: "receipt not found" }, 404);
    }
    if (!upstream.ok) {
      return jsonWithCors({ error: "upstream EAP server error" }, 502);
    }

    // Parse so we can annotate with source. If EAP's payload isn't JSON
    // (should never happen) fall back to opaque pass-through.
    const raw = await upstream.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
      payload.source = "upstream";
    } catch {
      return new NextResponse(raw, {
        status: 200,
        headers: {
          ...immutableCacheHeaders(),
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders(),
          "x-content-type-options": "nosniff",
        },
      });
    }

    return jsonWithCors(payload, 200, immutableCacheHeaders());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[eap-verify] proxy error:", msg);
    const isTimeout = msg.includes("aborted") || msg.includes("timeout");
    return jsonWithCors(
      { error: isTimeout ? "upstream timeout" : "upstream unavailable" },
      502,
    );
  }
}

/** CORS preflight so third-party audit tools can verify from a browser. */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-allow-headers": "accept",
      "access-control-max-age": "86400",
    },
  });
}

async function loadFromMirror(receiptId: string): Promise<MirrorRow | null> {
  try {
    const [row] = await db
      .select({
        receiptId: eapReceipts.receiptId,
        merkleRoot: eapReceipts.merkleRoot,
        signature: eapReceipts.signature,
        signed: eapReceipts.signed,
        eventCount: eapReceipts.eventCount,
        attestor: eapReceipts.attestor,
        createdAt: eapReceipts.createdAt,
        verified: eapReceipts.verified,
      })
      .from(eapReceipts)
      .where(eq(eapReceipts.receiptId, receiptId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    // DB hiccup must not brick public verification — fall back to upstream.
    console.error(
      "[eap-verify] mirror read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  };
}

function immutableCacheHeaders(): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
}

function jsonWithCors(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...corsHeaders(), ...extra },
  });
}

/**
 * Fetch with a hard byte cap. Shields us from a misconfigured upstream
 * sending an unbounded stream.
 */
async function fetchWithLimit(
  url: string,
  init: RequestInit,
  maxBytes: number,
): Promise<Response> {
  const res = await fetch(url, init);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`upstream too large (${declared} > ${maxBytes})`);
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
      throw new Error(`upstream exceeded ${maxBytes} bytes`);
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
