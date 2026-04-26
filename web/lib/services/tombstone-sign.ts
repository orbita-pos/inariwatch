/**
 * Tombstone signing — Track E pieza 11 (zero-retention mode).
 *
 * When a banking/healthcare client sets `INARIWATCH_ZERO_RETENTION=true` on
 * their SDK, the server is contractually forbidden from persisting their
 * error events. This module produces a cryptographically signed receipt
 * ("tombstone") that proves the event was processed (analyzed, deduplicated,
 * notified) without ever touching `alerts` table.
 *
 * Trust anchor:
 *   The tombstone keypair lives entirely in `web` (env: INARIWATCH_TOMBSTONE_KEY_HEX,
 *   32-byte secret hex-encoded). It is INTENTIONALLY separate from the EAP
 *   attestor key — tombstones are a different domain (zero-retention proofs,
 *   no Merkle tree, no chain) and tying them to the EAP server would add
 *   network RTT to every webhook hit on the zero-retention hot path.
 *
 *   The public key is exposed via GET /api/eap/verify/tombstone/attestor
 *   so auditors can pin the trust anchor once.
 *
 * Protocol (must match `verifyEd25519Signature` in eap-verify-local.ts):
 *   - canonical = canonical_json({v, ts, fingerprint_hash, processed_actions,
 *                                 integration_id, key_id})
 *   - tombstone_id = hex(SHA-256(canonical))            // 64 hex
 *   - signature   = ed25519_sign(SHA-256(tombstone_id_utf8))  // 64 bytes
 *   - sig field   = "ed25519:<128 hex>"
 *
 * The double SHA-256 is intentional: we keep the same domain-separation
 * primitive used by the EAP attestor (sign(SHA-256(receipt_id))) so the
 * verifier reuses verifyEd25519Signature unchanged.
 */

import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";

// ── Public types ────────────────────────────────────────────────────────────

/** Protocol version for forward compat. Bump only on breaking changes. */
export const TOMBSTONE_PROTOCOL_VERSION = 1 as const;

export type ProcessedAction =
  | "deduplicated"
  | "analyzed"
  | "notified"
  | "skipped_maintenance";

/** The canonical fields hashed into `tombstone_id`. Order does NOT matter
 *  here — `canonicalJsonStringify` sorts keys before hashing. Keep this
 *  type in sync with the auditor verifier in
 *  `web/app/api/eap/verify/tombstone/[hash]/route.ts`. */
export interface TombstoneContent {
  v: typeof TOMBSTONE_PROTOCOL_VERSION;
  ts: string; // ISO 8601 UTC
  fingerprint_hash: string; // hex(SHA-256(fingerprint))
  processed_actions: ProcessedAction[];
  integration_id: string; // uuid
  key_id: string; // 16 hex (SHA-256(pubkey)[0..8])
}

export interface SignedTombstone extends TombstoneContent {
  tombstone_id: string; // 64 hex — content-addressed handle
  sig: string; // "ed25519:<128 hex>"
  pubkey: string; // 64 hex — convenience copy for auditors
}

// ── Key loading ────────────────────────────────────────────────────────────

interface LoadedKey {
  /** Node KeyObject for signing. */
  privateKey: import("node:crypto").KeyObject;
  /** 32-byte raw public key (hex). */
  publicKeyHex: string;
  /** First 16 hex chars of SHA-256(public_key_bytes). */
  keyId: string;
}

let cachedKey: LoadedKey | null = null;
let cacheVersion: string | null = null;

/**
 * Load the tombstone signing key from env. Cached after first call so we
 * don't pay the PEM-decode + KeyObject-build cost on every webhook.
 * Returns null when the env var is unset — callers translate that to an
 * "unsigned" tombstone response (still useful for non-compliance clients
 * who turned the flag on by accident).
 */
export function loadTombstoneKey(): LoadedKey | null {
  const hex = process.env.INARIWATCH_TOMBSTONE_KEY_HEX;
  if (!hex) {
    return null;
  }
  // Invalidate cache when env rotates (matters for tests + zero-downtime
  // key rotation via Kamal env push).
  if (cachedKey && cacheVersion === hex) {
    return cachedKey;
  }

  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    console.error(
      "[tombstone-sign] INARIWATCH_TOMBSTONE_KEY_HEX must be exactly 64 hex chars (32 bytes)",
    );
    return null;
  }

  const secret = Buffer.from(hex, "hex");

  // RFC 8410 PKCS#8 prefix for Ed25519 private keys is fixed: 16 bytes.
  // Build the DER directly so we don't pull in another dep.
  const pkcs8 = Buffer.concat([
    Buffer.from(
      "302e020100300506032b657004220420",
      "hex",
    ),
    secret,
  ]);
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });

  // Derive public key bytes by re-creating the corresponding KeyObject and
  // exporting the JWK (`x` is base64url of the raw 32-byte pubkey).
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) {
    console.error("[tombstone-sign] failed to derive Ed25519 public key");
    return null;
  }
  const publicKeyBytes = Buffer.from(jwk.x, "base64url");
  const publicKeyHex = publicKeyBytes.toString("hex");
  const keyId = createHash("sha256")
    .update(publicKeyBytes)
    .digest()
    .subarray(0, 8)
    .toString("hex");

  cachedKey = { privateKey, publicKeyHex, keyId };
  cacheVersion = hex;
  return cachedKey;
}

/** Test seam: drop the cached key so the next call re-reads env. */
export function __resetTombstoneKeyForTesting(): void {
  cachedKey = null;
  cacheVersion = null;
}

// ── Canonical JSON ─────────────────────────────────────────────────────────

/**
 * Recursive sorted-keys canonical JSON. Same algorithm as
 * eap-verify-local.ts so the verifier path uses identical bytes.
 * Arrays preserve order; primitives pass through JSON.stringify.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface SignTombstoneInput {
  fingerprint: string;
  integrationId: string;
  processedActions: ProcessedAction[];
  /** Override timestamp (defaults to Date.now()). Used by tests for stable
   *  fixtures. */
  ts?: string;
}

export type SignResult =
  | { ok: true; tombstone: SignedTombstone }
  | { ok: false; reason: "key-unavailable" | "key-malformed" };

/**
 * Sign a tombstone for a processed-but-not-persisted event.
 * Pure CPU + ~1 SHA-256 + ~1 Ed25519 sign — should run in <1ms even on a
 * cold serverless instance.
 *
 * The result is JSON-safe and can be returned directly in the webhook
 * response body. The SDK appends it to ~/.inariwatch/tombstones.jsonl.
 */
export function signTombstone(input: SignTombstoneInput): SignResult {
  const key = loadTombstoneKey();
  if (!key) {
    return { ok: false, reason: "key-unavailable" };
  }

  // Sort processed actions deterministically so two events with the same
  // outcome (just different action ordering) sign to the same canonical
  // bytes — purely a hygiene property; the wire is always sorted.
  const processedActions = [...input.processedActions].sort();

  const fingerprintHash = createHash("sha256")
    .update(input.fingerprint, "utf8")
    .digest("hex");

  const content: TombstoneContent = {
    v: TOMBSTONE_PROTOCOL_VERSION,
    ts: input.ts ?? new Date().toISOString(),
    fingerprint_hash: fingerprintHash,
    processed_actions: processedActions,
    integration_id: input.integrationId,
    key_id: key.keyId,
  };

  const canonical = canonicalJsonStringify(content);
  const tombstoneId = createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");

  // Sign SHA-256(tombstone_id_utf8) — same primitive as receipt signing.
  // This means verifyEd25519Signature({receiptId: tombstone_id, ...}) works
  // as-is in the auditor verify endpoint.
  const digest = createHash("sha256").update(tombstoneId, "utf8").digest();
  let signatureHex: string;
  try {
    const sigBytes = cryptoSign(null, digest, key.privateKey);
    signatureHex = sigBytes.toString("hex");
  } catch (err) {
    console.error(
      "[tombstone-sign] Ed25519 sign failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "key-malformed" };
  }

  return {
    ok: true,
    tombstone: {
      ...content,
      tombstone_id: tombstoneId,
      sig: `ed25519:${signatureHex}`,
      pubkey: key.publicKeyHex,
    },
  };
}

/**
 * Public attestor info for auditors. Exposed via
 * GET /api/eap/verify/tombstone/attestor.
 */
export function getTombstoneAttestorInfo(): {
  keyAvailable: boolean;
  publicKey: string | null;
  keyId: string | null;
  algorithm: "ed25519";
} {
  const key = loadTombstoneKey();
  if (!key) {
    return {
      keyAvailable: false,
      publicKey: null,
      keyId: null,
      algorithm: "ed25519",
    };
  }
  return {
    keyAvailable: true,
    publicKey: key.publicKeyHex,
    keyId: key.keyId,
    algorithm: "ed25519",
  };
}
