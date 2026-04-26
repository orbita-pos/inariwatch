/**
 * Capture Payload v2 server-side verification (Track A piece 17, server side).
 *
 * Flow:
 *   1. Reject if `schema_version !== "2.0"`.
 *   2. Validate the `signature` block shape (hex lengths, alg).
 *   3. Recompute the Merkle root from `evidence` using the canonical JSON
 *      algo + single-leaf duplicate-pad layout. Reject if it doesn't match
 *      `signature.evidence_merkle_root`.
 *   4. Ed25519-verify the signature using the embedded `signer_pubkey`.
 *
 * Trust model — "trust on first use", per-install:
 *   The pubkey lives inside the payload itself. The SDK's per-install
 *   keypair acts as a stable identity for that deployment. We don't attempt
 *   key rotation policy at the webhook layer — that lives in a future
 *   audit/admin pass. Two signed events from the same `pub_key_id` are
 *   guaranteed to come from the same install (or someone with its private
 *   key, which is no different from compromising any HMAC secret).
 *
 * Deliberately reuses the protocol from `eap-verify-local.ts` so server
 * code stays single-protocol:
 *   - SHA-256 pre-hash domain separation
 *   - Same canonical JSON encoder
 *   - Same Merkle layout
 *
 * Fast-path fallthrough: this module returns `{ verified: false, reason }`
 * for every failure mode so the route can decide policy (drop event vs.
 * accept-but-flag) without try/catch around every call.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

// ── Wire-format types (snake_case at the boundary) ──────────────────────────

export interface PayloadV2SignatureBlock {
  alg: "ed25519";
  pub_key_id: string;
  signer_pubkey: string;
  evidence_merkle_root: string;
  sig: string;
  signed_at: string;
}

export interface PayloadV2Body {
  schema_version: "2.0";
  fingerprint: string;
  title: string;
  evidence: Record<string, unknown>;
  signature: PayloadV2SignatureBlock;
  // Other v2 fields exist but verification only consumes evidence + signature.
  [k: string]: unknown;
}

// ── Verification ────────────────────────────────────────────────────────────

export type V2VerifyFailureReason =
  | "not-v2"
  | "missing-signature"
  | "malformed-signature"
  | "merkle-mismatch"
  | "signature-invalid";

export type V2VerifyResult =
  | { verified: true; receiptId: string; pubKeyId: string; signerPubkey: string }
  | { verified: false; reason: V2VerifyFailureReason };

const SIGNATURE_HEX_LEN = 128;
const PUBKEY_HEX_LEN = 64;
const ROOT_HEX_LEN = 64;
const PUB_KEY_ID_HEX_LEN = 16;

/**
 * Inspect a parsed JSON event and verify its v2 signature block. Pure
 * function — no I/O, no DB, no logging. Caller is responsible for the
 * downstream actions (alert creation, eap_receipts insert, structured log).
 */
export function verifyCaptureV2Payload(
  event: Record<string, unknown>,
): V2VerifyResult {
  if (event.schema_version !== "2.0") {
    return { verified: false, reason: "not-v2" };
  }

  const sig = event.signature as PayloadV2SignatureBlock | undefined;
  if (!sig || typeof sig !== "object") {
    return { verified: false, reason: "missing-signature" };
  }

  if (
    sig.alg !== "ed25519" ||
    typeof sig.sig !== "string" ||
    sig.sig.length !== SIGNATURE_HEX_LEN ||
    !isHex(sig.sig) ||
    typeof sig.signer_pubkey !== "string" ||
    sig.signer_pubkey.length !== PUBKEY_HEX_LEN ||
    !isHex(sig.signer_pubkey) ||
    typeof sig.evidence_merkle_root !== "string" ||
    sig.evidence_merkle_root.length !== ROOT_HEX_LEN ||
    !isHex(sig.evidence_merkle_root) ||
    typeof sig.pub_key_id !== "string" ||
    sig.pub_key_id.length !== PUB_KEY_ID_HEX_LEN ||
    !isHex(sig.pub_key_id)
  ) {
    return { verified: false, reason: "malformed-signature" };
  }

  const evidence = event.evidence;
  if (!evidence || typeof evidence !== "object") {
    return { verified: false, reason: "malformed-signature" };
  }

  // Step 1: recompute the Merkle root from canonical evidence.
  const recomputed = recomputeEvidenceRoot(evidence);
  if (recomputed.toLowerCase() !== sig.evidence_merkle_root.toLowerCase()) {
    return { verified: false, reason: "merkle-mismatch" };
  }

  // Step 2: Ed25519-verify the signature on SHA-256(receipt_id_hex_utf8).
  const ok = verifyEd25519(sig.evidence_merkle_root, sig.sig, sig.signer_pubkey);
  if (!ok) {
    return { verified: false, reason: "signature-invalid" };
  }

  // Step 3: also confirm the embedded pub_key_id is a valid prefix of
  // SHA-256(pubkey). Cheap guard against accidentally-mismatched fields.
  const derivedKeyId = createHash("sha256")
    .update(Buffer.from(sig.signer_pubkey, "hex"))
    .digest("hex")
    .slice(0, PUB_KEY_ID_HEX_LEN);
  if (derivedKeyId.toLowerCase() !== sig.pub_key_id.toLowerCase()) {
    return { verified: false, reason: "malformed-signature" };
  }

  return {
    verified: true,
    receiptId: sig.evidence_merkle_root.toLowerCase(),
    pubKeyId: sig.pub_key_id.toLowerCase(),
    signerPubkey: sig.signer_pubkey.toLowerCase(),
  };
}

// ── Merkle + Ed25519 primitives ─────────────────────────────────────────────

/**
 * Single-leaf, duplicate-pad Merkle root over the canonical JSON of `evidence`.
 * Matches the SDK's `computeEvidenceMerkleRootSync` byte-for-byte.
 */
function recomputeEvidenceRoot(evidence: unknown): string {
  const canonical = canonicalJsonStringify(evidence);
  const leaf = createHash("sha256").update(canonical, "utf8").digest();
  const root = createHash("sha256").update(leaf).update(leaf).digest();
  return root.toString("hex");
}

function verifyEd25519(
  receiptIdHex: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const digest = createHash("sha256").update(receiptIdHex, "utf8").digest();
  const pubBytes = Buffer.from(publicKeyHex, "hex");
  const keyObj = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pubBytes.toString("base64url") },
    format: "jwk",
  });
  try {
    return cryptoVerify(null, digest, keyObj, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Canonical JSON: keys sorted alphabetically, recursively. Byte-identical
 * to the SDK's `canonicalJsonStringify` and to `eap-verify-local.ts`'s
 * private function. Kept as a fresh copy here so this module has no
 * cross-feature import — `eap-verify-local` is for EAP-server receipts
 * (different protocol shape).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

// ── Persistence helper ──────────────────────────────────────────────────────

/**
 * Insert (or upsert) an `eap_receipts` row for a verified v2 payload.
 * Idempotent: ON CONFLICT (receiptId) DO NOTHING — same payload re-signed
 * by the same install will produce the same receiptId, and we'd rather
 * skip the duplicate than fail the webhook.
 *
 * The eap_receipts table has historically been EAP-server-attestor receipts;
 * `attestor` is set to "capture-sdk:<pub_key_id>" so admin queries can
 * separate the two trust roots.
 */
export async function insertCaptureReceipt(params: {
  receiptId: string;
  alertId: string;
  signatureHex: string;
  pubKeyId: string;
  signerPubkey: string;
  eventCount?: number;
}): Promise<void> {
  const { db } = await import("@/lib/db");
  const { eapReceipts } = await import("@/lib/db/schema");
  const { sql } = await import("drizzle-orm");

  await db
    .insert(eapReceipts)
    .values({
      receiptId: params.receiptId,
      alertId: params.alertId,
      recordingId: `cap-v2:${params.receiptId.slice(0, 16)}`,
      merkleRoot: params.receiptId,
      signature: params.signatureHex,
      signed: true,
      eventCount: params.eventCount ?? 1,
      attestor: `capture-sdk:${params.pubKeyId}`,
      verified: true,
      verifiedAt: new Date(),
    })
    .onConflictDoNothing({ target: eapReceipts.receiptId })
    .catch((err) => {
      console.error(
        "[capture-v2-verify] eap_receipts insert failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

  // sql import retained in case future ON CONFLICT clauses need it.
  void sql;
}
