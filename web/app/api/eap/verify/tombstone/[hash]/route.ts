import { NextRequest, NextResponse } from "next/server";
import { checkWebhookRateLimit, extractClientIp } from "@/lib/webhooks/rate-limit";
import { verifyEd25519Signature } from "@/lib/services/eap-verify-local";
import {
  canonicalJsonStringify,
  getTombstoneAttestorInfo,
  type TombstoneContent,
  TOMBSTONE_PROTOCOL_VERSION,
} from "@/lib/services/tombstone-sign";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Track E pieza 11 — Public tombstone verification endpoint.
 *
 *   POST /api/eap/verify/tombstone/:hash
 *
 * Auditors verify a tombstone end-to-end without ever touching our DB:
 *
 *   1. POST the full tombstone JSON (the same object the SDK persisted to
 *      ~/.inariwatch/tombstones.jsonl) with `:hash` in the URL = the
 *      `tombstone_id` field. The redundancy is intentional — clients must
 *      send the hash they trust both in the URL and the body, and we
 *      verify they match (defense in depth against accidental tampering
 *      while transcribing the tombstone).
 *   2. We recompute the canonical hash from the body and ensure it
 *      matches `:hash` (Merkle-equivalent integrity check).
 *   3. We Ed25519-verify the signature against our pinned attestor
 *      pubkey (loaded from env on this same web server — same key that
 *      signed it).
 *
 * This is fully stateless: there is no record of the tombstone in our
 * DB (that's the whole point of zero-retention mode). Authority comes
 * from the cryptographic chain alone.
 *
 * GET on this route returns the public attestor info so clients can
 * discover the pubkey + key_id without parsing a tombstone first.
 *
 * No auth, rate-limited by IP. CORS `*` for GET so third-party audit
 * tooling can pull pubkey from a browser.
 */

/** Canonical hash format = 64 hex chars (SHA-256 hex). */
const HASH_REGEX = /^[0-9a-f]{64}$/i;

/**
 * GET /api/eap/verify/tombstone/:hash
 *
 * Two modes:
 *   - `:hash` == "attestor" → return public attestor info (pubkey, key_id).
 *   - `:hash` matches HASH_REGEX → 405 Method Not Allowed (auditors must
 *     POST the full tombstone body for verification).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
): Promise<NextResponse> {
  const { hash } = await params;

  if (hash === "attestor") {
    return jsonWithCors(getTombstoneAttestorInfo(), 200, immutableCacheHeaders());
  }

  if (!HASH_REGEX.test(hash)) {
    return jsonWithCors(
      { error: "hash must be 64 hex characters or the literal 'attestor'" },
      400,
    );
  }

  return jsonWithCors(
    {
      error: "method not allowed",
      hint: "POST the tombstone body to this URL to verify; GET /attestor returns pubkey",
    },
    405,
  );
}

interface VerifyRequestBody {
  v?: number;
  ts?: string;
  fingerprint_hash?: string;
  processed_actions?: unknown;
  integration_id?: string;
  key_id?: string;
  tombstone_id?: string;
  sig?: string;
  pubkey?: string;
}

/**
 * POST /api/eap/verify/tombstone/:hash
 *
 * Body must be the full SignedTombstone object (as returned by the
 * webhook). We verify content + signature + pubkey trust anchor.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
): Promise<NextResponse> {
  const { hash } = await params;
  if (!HASH_REGEX.test(hash)) {
    return jsonWithCors({ error: "hash must be 64 hex characters" }, 400);
  }

  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return jsonWithCors({ error: "Too many requests" }, 429, {
      "Retry-After": "60",
    });
  }

  let body: VerifyRequestBody;
  try {
    body = (await req.json()) as VerifyRequestBody;
  } catch {
    return jsonWithCors({ error: "invalid JSON body" }, 400);
  }

  // Step 1: structural validation. Reject anything missing the fields
  // we need to recompute the canonical hash.
  if (
    body.v !== TOMBSTONE_PROTOCOL_VERSION ||
    typeof body.ts !== "string" ||
    typeof body.fingerprint_hash !== "string" ||
    !Array.isArray(body.processed_actions) ||
    !body.processed_actions.every((a) => typeof a === "string") ||
    typeof body.integration_id !== "string" ||
    typeof body.key_id !== "string" ||
    typeof body.tombstone_id !== "string" ||
    typeof body.sig !== "string"
  ) {
    return jsonWithCors(
      {
        verified: false,
        reason: "malformed",
        detail: "missing or wrong-typed required tombstone fields",
      },
      400,
    );
  }

  if (body.tombstone_id.toLowerCase() !== hash.toLowerCase()) {
    return jsonWithCors(
      {
        verified: false,
        reason: "hash-url-mismatch",
        detail: "URL hash does not match tombstone_id in body",
      },
      400,
    );
  }

  // Step 2: pin the pubkey to our local attestor — auditors never trust
  // the body's `pubkey` field directly. The canonical key_id pin is what
  // makes a tombstone forgery-resistant: an attacker minting their own
  // tombstone with their own keypair will produce a different key_id
  // than the one we publish, and we'll reject it here.
  const attestor = getTombstoneAttestorInfo();
  if (!attestor.keyAvailable || !attestor.publicKey || !attestor.keyId) {
    return jsonWithCors(
      {
        verified: false,
        reason: "attestor-unavailable",
        detail: "INARIWATCH_TOMBSTONE_KEY_HEX is not configured on this server",
      },
      503,
    );
  }
  if (body.key_id.toLowerCase() !== attestor.keyId.toLowerCase()) {
    return jsonWithCors(
      {
        verified: false,
        reason: "key-id-mismatch",
        detail: "tombstone was signed by a different attestor key",
      },
      200, // 200 because the verdict is well-defined: "not signed by us"
    );
  }

  // Step 3: recompute canonical hash. Must match tombstone_id byte-for-byte.
  const content: TombstoneContent = {
    v: TOMBSTONE_PROTOCOL_VERSION,
    ts: body.ts,
    fingerprint_hash: body.fingerprint_hash,
    processed_actions: body.processed_actions as TombstoneContent["processed_actions"],
    integration_id: body.integration_id,
    key_id: body.key_id,
  };
  const canonical = canonicalJsonStringify(content);
  const recomputed = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (recomputed.toLowerCase() !== body.tombstone_id.toLowerCase()) {
    return jsonWithCors(
      { verified: false, reason: "content-hash-mismatch" },
      200,
    );
  }

  // Step 4: parse "ed25519:<hex>" prefix and Ed25519-verify.
  const sigParts = body.sig.split(":");
  if (sigParts.length !== 2 || sigParts[0] !== "ed25519") {
    return jsonWithCors(
      { verified: false, reason: "malformed", detail: "sig must be ed25519:<hex>" },
      400,
    );
  }
  const signatureHex = sigParts[1]!;
  const sigOk = verifyEd25519Signature({
    receiptId: body.tombstone_id,
    signatureHex,
    publicKeyHex: attestor.publicKey,
  });
  if (!sigOk) {
    return jsonWithCors(
      { verified: false, reason: "signature-invalid" },
      200,
    );
  }

  return jsonWithCors(
    {
      verified: true,
      tombstone_id: body.tombstone_id,
      key_id: attestor.keyId,
      pubkey: attestor.publicKey,
      attestor: "inariwatch",
      processed_actions: body.processed_actions,
      ts: body.ts,
    },
    200,
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-allow-headers": "content-type, accept",
      "access-control-max-age": "86400",
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function immutableCacheHeaders(): Record<string, string> {
  return {
    "cache-control": "public, max-age=300, stale-while-revalidate=86400",
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
