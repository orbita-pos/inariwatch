/**
 * Local EAP receipt verification — Fase 11 follow-up.
 *
 * Until now Gate 6 (`eap_chain_verified`) depended on the EAP server's own
 * `verification.all_signatures_valid` response served via GET /chain/:id.
 * That couples every auto-merge decision to an external RTT and to the
 * server's own reporting. If the server is momentarily degraded, or its
 * verification code regresses, Gate 6 silently skips.
 *
 * This module moves the trust anchor local:
 *
 *   1. Fetch the current attestor public key from the EAP server once,
 *      cache it in Redis (24h), and pin it as the trusted identity.
 *   2. For any receipt, run Ed25519 verification IN-PROCESS against the
 *      pinned pubkey. Never delegate the verdict.
 *   3. Optionally recompute the Merkle root from the original event
 *      stream (defense in depth) — catches mirror-level tampering.
 *
 * Protocol (MUST stay in sync with `eap-receipt/src/signing.rs`):
 *   - digest      = SHA-256(receipt_id.as_bytes())
 *   - verified    = Ed25519.verify(public_key, digest, signature)
 *   - key_id      = hex(SHA-256(public_key_bytes)[0..8])
 *   - merkle leaf = SHA-256(canonical_json(event))
 *   - merkle      = standard binary tree with duplicate-last padding PER LEVEL
 *                   (intentionally different from Bitcoin's leaf-only padding
 *                   to avoid CVE-2012-2459)
 *
 * No third-party crypto library — native Node `crypto` only. Ed25519 is
 * supported out of the box since Node 15; we target Node ≥20 on Vercel.
 *
 * Env:
 *   EAP_SERVER_URL             — base URL (required; verify is inert without it)
 *   EAP_LOCAL_VERIFY_ENABLED   — feature flag, "true" to activate. Default off
 *                                lets us ship the code + observe in shadow
 *                                before flipping Gate 6's source of truth.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { getRedis } from "@/lib/redis";

// ── Types ──────────────────────────────────────────────────────────────────

/** Shape returned by EAP server's GET /attestor. */
export interface AttestorInfo {
  keyAvailable: boolean;
  publicKey: string | null;   // 64 hex chars when keyAvailable
  keyId: string | null;       // 16 hex chars when keyAvailable
  attestorName: string | null;
  algorithm: "ed25519";
}

export type VerifyFailureReason =
  | "disabled"               // feature flag off
  | "eap-not-configured"     // EAP_SERVER_URL unset
  | "attestor-unavailable"   // /attestor returned key_available=false
  | "attestor-fetch-failed"  // network / HTTP error reaching /attestor
  | "unsigned"               // receipt has no signature (signed=false)
  | "malformed"              // hex decode or length validation failed
  | "pubkey-mismatch"        // receipt's pubkey != pinned attestor pubkey
  | "signature-invalid"      // Ed25519 verification returned false
  | "merkle-mismatch";       // recomputed Merkle root != receipt_id

export type LocalVerifyResult =
  | {
      verified: true;
      keyId: string;
      durationMs: number;
    }
  | {
      verified: false;
      reason: VerifyFailureReason;
      durationMs: number;
    };

export interface VerifyReceiptInput {
  receiptId: string;          // 64 hex chars (Merkle root)
  signatureHex: string | null;
  /** When provided, pinned against the attestor pubkey fetched from the
   *  EAP server. If null, we fall back to the attestor's current pubkey —
   *  i.e. assume the receipt was signed by the currently-active key.
   *  The pubkey SHOULD be persisted from the `submit_from_events` response
   *  so rotation doesn't silently invalidate old receipts. */
  publicKeyHex?: string | null;
  /** Optional event stream for Merkle recompute (defense in depth). When
   *  omitted we trust the receiptId-as-Merkle-root claim and only verify
   *  the signature. */
  events?: unknown[];
}

// ── Feature flag ────────────────────────────────────────────────────────────

/** Local verification is opt-in so we can ship + shadow-run before Gate 6
 *  starts consuming the verdict. Flip to "true" via env when ready. */
export function isLocalVerifyEnabled(): boolean {
  return process.env.EAP_LOCAL_VERIFY_ENABLED === "true";
}

// ── Attestor info (Redis-cached) ────────────────────────────────────────────

const ATTESTOR_CACHE_KEY = "eap:attestor:current";
const ATTESTOR_CACHE_TTL_SECONDS = 24 * 60 * 60;
const ATTESTOR_FETCH_TIMEOUT_MS = 3_000;

/**
 * Fetch + cache the EAP server's current attestor identity. Redis-cached
 * for 24h; cache miss goes to the network with a short timeout. Key is
 * keyed by the server URL so rotating `EAP_SERVER_URL` invalidates the
 * cache implicitly.
 *
 * Returns null on any failure — callers translate that to
 * `attestor-unavailable` or `attestor-fetch-failed` as appropriate.
 */
export async function getAttestorInfo(opts: {
  force?: boolean;
} = {}): Promise<AttestorInfo | null> {
  const eapServerUrl = process.env.EAP_SERVER_URL;
  if (!eapServerUrl) return null;

  const cacheKey = `${ATTESTOR_CACHE_KEY}:${hashUrl(eapServerUrl)}`;
  const redis = getRedis();

  if (!opts.force && redis) {
    try {
      const cached = await redis.get<AttestorInfo>(cacheKey);
      if (cached && typeof cached === "object" && "keyAvailable" in cached) {
        return cached;
      }
    } catch (err) {
      // Cache read failure is not fatal — fall through to fetch.
      console.warn(
        "[eap-verify-local] redis read failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const info = await fetchAttestorInfo(eapServerUrl);
  if (!info) return null;

  if (redis) {
    try {
      await redis.set(cacheKey, info, { ex: ATTESTOR_CACHE_TTL_SECONDS });
    } catch (err) {
      console.warn(
        "[eap-verify-local] redis write failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return info;
}

async function fetchAttestorInfo(
  eapServerUrl: string,
): Promise<AttestorInfo | null> {
  try {
    const res = await fetch(`${eapServerUrl.replace(/\/$/, "")}/attestor`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ATTESTOR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        "[eap-verify-local] /attestor fetch returned",
        res.status,
      );
      return null;
    }
    const raw = (await res.json()) as {
      key_available?: boolean;
      public_key?: string | null;
      key_id?: string | null;
      attestor_name?: string | null;
      algorithm?: string;
    };
    return {
      keyAvailable: !!raw.key_available,
      publicKey: raw.public_key ?? null,
      keyId: raw.key_id ?? null,
      attestorName: raw.attestor_name ?? null,
      algorithm: "ed25519",
    };
  } catch (err) {
    console.error(
      "[eap-verify-local] /attestor network error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── Verification primitives ─────────────────────────────────────────────────

const SIGNATURE_HEX_LEN = 128; // 64 bytes
const PUBKEY_HEX_LEN = 64;     // 32 bytes
const RECEIPT_ID_HEX_LEN = 64; // 32 bytes (SHA-256 Merkle root)

/**
 * Core in-process Ed25519 verify. Matches the Rust server's protocol
 * (SHA-256 domain-separation pre-hash, then Ed25519). Never touches the
 * network or DB — pure CPU.
 */
export function verifyEd25519Signature(params: {
  receiptId: string;
  signatureHex: string;
  publicKeyHex: string;
}): boolean {
  const { receiptId, signatureHex, publicKeyHex } = params;

  if (
    signatureHex.length !== SIGNATURE_HEX_LEN ||
    publicKeyHex.length !== PUBKEY_HEX_LEN ||
    !isHex(signatureHex) ||
    !isHex(publicKeyHex)
  ) {
    return false;
  }

  const signature = Buffer.from(signatureHex, "hex");
  const pubkey = Buffer.from(publicKeyHex, "hex");

  const digest = createHash("sha256").update(receiptId, "utf8").digest();

  // Node's Ed25519 via JWK — `x` is base64url of the raw 32-byte pubkey.
  const keyObj = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: pubkey.toString("base64url"),
    },
    format: "jwk",
  });

  // Ed25519 in Node: algorithm is null, the curve is baked into the key.
  try {
    return cryptoVerify(null, digest, keyObj, signature);
  } catch {
    return false;
  }
}

/**
 * Re-derive the stable 16-hex key_id from a pubkey hex string. Must match
 * `derive_key_id` in `eap-receipt/src/signing.rs`.
 */
export function deriveKeyId(publicKeyHex: string): string | null {
  if (publicKeyHex.length !== PUBKEY_HEX_LEN || !isHex(publicKeyHex)) {
    return null;
  }
  const pubkey = Buffer.from(publicKeyHex, "hex");
  const digest = createHash("sha256").update(pubkey).digest();
  return digest.subarray(0, 8).toString("hex");
}

/**
 * Recompute the Merkle root from a canonical event stream. MUST match
 * `MerkleTree::from_items` in `eap-receipt/src/merkle.rs`:
 *   - leaf  = SHA-256(canonical_json(event))
 *   - node  = SHA-256(left || right)
 *   - padding: duplicate last at each level when odd
 *
 * Serde's `serde_json::to_value` canonicalizes key ordering via its internal
 * Map representation. We replicate this with a recursive key-sorted stringify.
 * Object key ordering is the only degree of freedom — everything else is
 * already canonical at the JSON text level for our event shapes.
 */
export function recomputeMerkleRoot(events: readonly unknown[]): string {
  if (events.length === 0) {
    return Buffer.alloc(32).toString("hex");
  }

  let currentLevel: Buffer[] = events.map((e) => {
    const canonical = canonicalJsonStringify(e);
    return createHash("sha256").update(canonical, "utf8").digest();
  });

  // Duplicate-last padding on the leaf level (matches Rust).
  if (currentLevel.length % 2 !== 0) {
    currentLevel.push(currentLevel[currentLevel.length - 1]!);
  }

  while (currentLevel.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]!;
      const right = currentLevel[i + 1]!;
      next.push(createHash("sha256").update(left).update(right).digest());
    }
    // Duplicate-last padding at each internal level (matches Rust;
    // intentionally NOT leaf-only padding → avoids CVE-2012-2459).
    if (next.length > 1 && next.length % 2 !== 0) {
      next.push(next[next.length - 1]!);
    }
    currentLevel = next;
  }
  return currentLevel[0]!.toString("hex");
}

/**
 * Canonical JSON encoder: sorts object keys alphabetically recursively.
 * Produces byte-for-byte output equivalent to Rust's
 * `serde_json::to_vec(&serde_json::to_value(&event))` for the event types
 * in `substrate_core::event::EventKind`.
 *
 * Arrays preserve order. Primitives pass through `JSON.stringify`.
 */
function canonicalJsonStringify(value: unknown): string {
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

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Verify a receipt locally. Flow:
 *   1. Feature flag check.
 *   2. Validate inputs (hex format, lengths).
 *   3. Fetch + pin attestor pubkey (Redis-cached).
 *   4. Verify receipt's embedded pubkey matches pinned (or use pinned when
 *      the receipt didn't store one).
 *   5. Ed25519 verify.
 *   6. Optional Merkle recompute.
 *
 * Structured log emitted on every call with `{ eventname: "eap_verify_local",
 * receipt_id, verified, reason, duration_ms }` for /admin/ops + SLO.
 */
export async function verifyReceiptLocally(
  input: VerifyReceiptInput,
): Promise<LocalVerifyResult> {
  const t0 = Date.now();

  const done = (r: LocalVerifyResult): LocalVerifyResult => {
    emitStructuredLog({
      receiptId: input.receiptId,
      result: r,
    });
    return r;
  };

  if (!isLocalVerifyEnabled()) {
    return done({ verified: false, reason: "disabled", durationMs: 0 });
  }
  if (!process.env.EAP_SERVER_URL) {
    return done({
      verified: false,
      reason: "eap-not-configured",
      durationMs: Date.now() - t0,
    });
  }

  // Step 1: input validation.
  if (
    input.receiptId.length !== RECEIPT_ID_HEX_LEN ||
    !isHex(input.receiptId)
  ) {
    return done({
      verified: false,
      reason: "malformed",
      durationMs: Date.now() - t0,
    });
  }
  if (!input.signatureHex) {
    return done({
      verified: false,
      reason: "unsigned",
      durationMs: Date.now() - t0,
    });
  }
  if (
    input.signatureHex.length !== SIGNATURE_HEX_LEN ||
    !isHex(input.signatureHex)
  ) {
    return done({
      verified: false,
      reason: "malformed",
      durationMs: Date.now() - t0,
    });
  }

  // Step 2: fetch pinned attestor.
  const attestor = await getAttestorInfo();
  if (!attestor) {
    return done({
      verified: false,
      reason: "attestor-fetch-failed",
      durationMs: Date.now() - t0,
    });
  }
  if (!attestor.keyAvailable || !attestor.publicKey) {
    return done({
      verified: false,
      reason: "attestor-unavailable",
      durationMs: Date.now() - t0,
    });
  }

  // Step 3: pubkey pinning.
  const pubkeyToUse = input.publicKeyHex ?? attestor.publicKey;
  if (
    input.publicKeyHex &&
    input.publicKeyHex.toLowerCase() !== attestor.publicKey.toLowerCase()
  ) {
    return done({
      verified: false,
      reason: "pubkey-mismatch",
      durationMs: Date.now() - t0,
    });
  }

  // Step 4: Ed25519 verify.
  const sigOk = verifyEd25519Signature({
    receiptId: input.receiptId,
    signatureHex: input.signatureHex,
    publicKeyHex: pubkeyToUse,
  });
  if (!sigOk) {
    return done({
      verified: false,
      reason: "signature-invalid",
      durationMs: Date.now() - t0,
    });
  }

  // Step 5: optional Merkle recompute.
  if (input.events && input.events.length > 0) {
    const recomputed = recomputeMerkleRoot(input.events);
    if (recomputed.toLowerCase() !== input.receiptId.toLowerCase()) {
      return done({
        verified: false,
        reason: "merkle-mismatch",
        durationMs: Date.now() - t0,
      });
    }
  }

  const keyId = attestor.keyId ?? deriveKeyId(pubkeyToUse) ?? "";
  return done({ verified: true, keyId, durationMs: Date.now() - t0 });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]+$/.test(s);
}

function hashUrl(url: string): string {
  // Short stable suffix for the cache key — we don't need crypto strength
  // here, just a compact, collision-resistant tag that survives URL edits
  // (trailing slash, https vs http at localhost, etc.).
  return createHash("sha256")
    .update(url.trim().replace(/\/$/, "").toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

/**
 * Emit a structured line for /admin/ops + SLO dashboards. Kept here so
 * every call site gets identical fields without threading a logger
 * parameter through the call chain.
 */
function emitStructuredLog(params: {
  receiptId: string;
  result: LocalVerifyResult;
}): void {
  const { receiptId, result } = params;
  const payload: Record<string, unknown> = {
    eventname: "eap_verify_local",
    receipt_id: receiptId,
    verified: result.verified,
    duration_ms: result.durationMs,
  };
  if (!result.verified) payload.reason = result.reason;
  else payload.key_id = result.keyId;
  console.log(JSON.stringify(payload));
}

// ── Persistence ────────────────────────────────────────────────────────────

/**
 * Persist a local verification result to the `eap_receipts.verified` +
 * `verified_at` columns. Safe to call in the background: failures are
 * logged but never thrown — a DB hiccup here must not brick the caller
 * (Gate 6 can always re-derive by calling `verifyReceiptLocally` again
 * later).
 *
 * Writes `verified = false` with a non-null `verified_at` for failures
 * other than `disabled` / `eap-not-configured` / `attestor-fetch-failed`
 * (those are environmental — don't persist them; try again next time).
 */
export async function persistVerificationOutcome(
  receiptId: string,
  result: LocalVerifyResult,
): Promise<void> {
  // Don't persist transient/environment failures — they're not a verdict
  // on the receipt itself, just a signal the verifier couldn't run now.
  if (!result.verified) {
    const transient: VerifyFailureReason[] = [
      "disabled",
      "eap-not-configured",
      "attestor-unavailable",
      "attestor-fetch-failed",
    ];
    if (transient.includes(result.reason)) return;
  }

  try {
    const { db } = await import("@/lib/db");
    const { eapReceipts } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    await db
      .update(eapReceipts)
      .set({
        verified: result.verified,
        verifiedAt: new Date(),
      })
      .where(eq(eapReceipts.receiptId, receiptId));
  } catch (err) {
    console.error(
      "[eap-verify-local] persist failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Convenience: verify AND persist in one call. Used by the cron sweep
 * and the on-first-hit lazy path in /api/eap/verify/:receiptId.
 */
export async function verifyAndPersist(
  input: VerifyReceiptInput,
): Promise<LocalVerifyResult> {
  const result = await verifyReceiptLocally(input);
  await persistVerificationOutcome(input.receiptId, result);
  return result;
}

// ── Backfill sweep ─────────────────────────────────────────────────────────

export interface SweepStats {
  scanned: number;
  verified: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Sweep receipts that haven't been locally verified yet. Used by the
 * `/api/cron/eap-verify-sweep` hourly cron + as a backfill helper.
 *
 *   SELECT FROM eap_receipts
 *   WHERE verified IS NULL
 *     AND signature IS NOT NULL
 *     AND created_at < now() - interval '1 hour'  -- grace for fresh writes
 *   ORDER BY created_at DESC
 *   LIMIT :batchSize
 *
 * Processing is bounded and idempotent. If the feature flag is off we
 * exit early — the route still returns 200 OK so cron health checks
 * pass.
 */
export async function sweepUnverifiedReceipts(opts: {
  batchSize?: number;
  gracePeriodSeconds?: number;
} = {}): Promise<SweepStats> {
  const batchSize = opts.batchSize ?? 200;
  const gracePeriodSeconds = opts.gracePeriodSeconds ?? 3600;
  const t0 = Date.now();
  const stats: SweepStats = {
    scanned: 0,
    verified: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };

  if (!isLocalVerifyEnabled() || !process.env.EAP_SERVER_URL) {
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const { db } = await import("@/lib/db");
  const { eapReceipts } = await import("@/lib/db/schema");
  const { and, isNull, isNotNull, lt, desc } = await import("drizzle-orm");

  const cutoff = new Date(Date.now() - gracePeriodSeconds * 1000);

  const rows = await db
    .select({
      receiptId: eapReceipts.receiptId,
      signature: eapReceipts.signature,
    })
    .from(eapReceipts)
    .where(
      and(
        isNull(eapReceipts.verified),
        isNotNull(eapReceipts.signature),
        lt(eapReceipts.createdAt, cutoff),
      ),
    )
    .orderBy(desc(eapReceipts.createdAt))
    .limit(batchSize);

  stats.scanned = rows.length;

  // Warm the attestor cache once up-front so each verify in the loop
  // hits Redis (no N network RTTs to /attestor).
  await getAttestorInfo();

  for (const row of rows) {
    if (!row.signature) {
      stats.skipped++;
      continue;
    }
    const result = await verifyAndPersist({
      receiptId: row.receiptId,
      signatureHex: row.signature,
    });
    if (result.verified) stats.verified++;
    else stats.failed++;
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}
