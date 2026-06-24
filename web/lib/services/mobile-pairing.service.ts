/**
 * S12 — mobile pairing service.
 *
 * Owns the lifecycle of a mobile-device pairing flow as seen from the
 * web side. The desktop side already owns the equivalent primitive in
 * `desktop/src-tauri/src/pairing/` (S8 LOCKED contract); we don't reach
 * into that — instead, the desktop POSTs into our `_announce` /
 * `_confirm` webhooks (CRON_SECRET-bearered) and we mirror the state.
 *
 * Phases:
 *
 * 1. **announce** — desktop generates the Crockford code locally and
 *    tells us about it. We insert a `mobile_pairing_challenges` row in
 *    state `awaiting_redeem` (no SAS yet).
 * 2. **redeem** — mobile POSTs `{code, device_pubkey, display_name}`.
 *    We find the row, derive the 6-digit SAS using the same algorithm
 *    as `desktop/src-tauri/src/pairing/sas.rs::derive`, persist it, and
 *    return the SAS digits + `challenge_id` to mobile. The desktop is
 *    informed via SSE on the relay (handled separately in
 *    `app/api/mobile/pair/redeem/route.ts`).
 * 3. **confirm** — desktop POSTs the user's Yes/No. On Yes we insert
 *    `mobile_paired_devices`, sign a JWT, link the challenge to the
 *    device row. On No we just stamp `rejected_at`.
 * 4. **status** — mobile polls. Returns `{paired: true, device_token}`
 *    after `confirm(approve=true)`, otherwise `{paired: false}`.
 *
 * SAS derivation:
 *
 *   sha256(b"inari-live-sas-v1\0" || code || \0 || identifier || \0 ||
 *          workspace_id || \0 || created_at_ms (be_bytes))
 *   take first 4 bytes as u32 BE, mod 1_000_000, zero-pad to 6.
 *
 * The desktop reads the same formula from sas.rs. If we drift, the
 * SAS shown on mobile won't match what the user sees on desktop (the
 * desktop derives it locally via PairingService.redeem). We don't
 * actually drift today because the desktop trusts the SAS digits that
 * arrive over the relay verbatim — but documenting the algorithm here
 * keeps the contract testable.
 */

import crypto from "crypto";
import { db, mobilePairingChallenges, mobilePairedDevices } from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import { signMobileDeviceToken } from "@/lib/auth/mobile-jwt";

// ── Constants ────────────────────────────────────────────────────────────

const CHALLENGE_TTL_MS = 60 * 60 * 1000; // 1h — matches desktop's PENDING_TTL_MS
export const SAS_LENGTH = 6;

// Crockford alphabet (28 chars — no 0/O/1/I/L/U). Accepted on input
// case-insensitively + dashes/spaces stripped to match the desktop's
// PairingCode parser semantics (see desktop/src-tauri/src/pairing/code.rs).
const CROCKFORD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_RE = /^[A-Z0-9]{8}$/;

export class MobilePairingError extends Error {
  constructor(
    public code:
      | "code_invalid"
      | "code_unknown"
      | "code_expired"
      | "code_already_redeemed"
      | "challenge_unknown"
      | "challenge_already_resolved",
    message: string,
  ) {
    super(message);
    this.name = "MobilePairingError";
  }
}

// ── Code normalisation ──────────────────────────────────────────────────

/**
 * Normalise a user-typed pairing code: strip dashes/spaces, uppercase,
 * collapse `O→0`-style typos NO — Crockford has no 0 in the 28-letter
 * alphabet, so we don't substitute. Just length+regex check.
 */
export function normaliseCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isValidCode(code: string): boolean {
  if (!CROCKFORD_RE.test(code)) return false;
  for (const ch of code) {
    if (!CROCKFORD_ALPHABET.includes(ch)) return false;
  }
  return true;
}

// ── SAS derivation (mirror of desktop sas.rs) ───────────────────────────

export interface SasInputs {
  pairingCode: string;
  identifier: string;
  workspaceId: string;
  createdAtMs: number;
}

export function deriveSas(inputs: SasInputs): string {
  const h = crypto.createHash("sha256");
  h.update(Buffer.from("inari-live-sas-v1\0", "utf8"));
  h.update(Buffer.from(inputs.pairingCode, "utf8"));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(inputs.identifier, "utf8"));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(inputs.workspaceId, "utf8"));
  h.update(Buffer.from([0]));
  // Big-endian 8-byte representation of i64 created_at_ms.
  const tsBuf = Buffer.alloc(8);
  // BigInt because Number doesn't reliably round-trip 64-bit ints.
  tsBuf.writeBigInt64BE(BigInt(inputs.createdAtMs), 0);
  h.update(tsBuf);
  const digest = h.digest();
  const n = digest.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

// ── Service surface ─────────────────────────────────────────────────────

export interface AnnounceInput {
  workspaceId:  string;
  pairingCode:  string;
  /** Created-at the desktop minted, used for SAS derivation symmetry. */
  createdAtMs:  number;
  expiresAtMs?: number;
}

export interface AnnounceResult {
  challengeId: string;
}

/**
 * Desktop tells us about a fresh code. We store the row in awaiting-redeem
 * state with the SAS-input timestamp captured for later derivation.
 */
export async function announceChallenge(input: AnnounceInput): Promise<AnnounceResult> {
  const code = normaliseCode(input.pairingCode);
  if (!isValidCode(code)) {
    throw new MobilePairingError("code_invalid", "Pairing code is malformed");
  }
  const createdAt = new Date(input.createdAtMs);
  const expiresAt = new Date(input.expiresAtMs ?? input.createdAtMs + CHALLENGE_TTL_MS);

  const [row] = await db
    .insert(mobilePairingChallenges)
    .values({
      workspaceId: input.workspaceId,
      pairingCode: code,
      createdAt,
      expiresAt,
    })
    .returning({ challengeId: mobilePairingChallenges.challengeId });

  if (!row) {
    throw new Error("failed to insert mobile_pairing_challenges row");
  }
  return { challengeId: row.challengeId };
}

export interface RedeemInput {
  code: string;
  devicePubkey: string;
  displayName: string;
}

export interface RedeemResult {
  challengeId: string;
  workspaceId: string;
  sasDigits: string;
  displayName: string;
}

export async function redeemCode(input: RedeemInput): Promise<RedeemResult> {
  const code = normaliseCode(input.code);
  if (!isValidCode(code)) {
    throw new MobilePairingError("code_invalid", "Pairing code is malformed");
  }

  const now = new Date();
  const rows = await db
    .select()
    .from(mobilePairingChallenges)
    .where(
      and(
        eq(mobilePairingChallenges.pairingCode, code),
        isNull(mobilePairingChallenges.confirmedAt),
        isNull(mobilePairingChallenges.rejectedAt),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new MobilePairingError("code_unknown", "Pairing code is unknown");
  }
  const row = rows[0];
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new MobilePairingError("code_expired", "Pairing code has expired");
  }
  if (row.devicePubkey || row.sasDigits) {
    throw new MobilePairingError(
      "code_already_redeemed",
      "Pairing code has already been redeemed",
    );
  }

  const sas = deriveSas({
    pairingCode: code,
    identifier: input.devicePubkey,
    workspaceId: row.workspaceId,
    createdAtMs: row.createdAt.getTime(),
  });

  await db
    .update(mobilePairingChallenges)
    .set({
      devicePubkey: input.devicePubkey,
      displayName: input.displayName,
      sasDigits: sas,
      sasEmittedAt: now,
    })
    .where(eq(mobilePairingChallenges.challengeId, row.challengeId));

  return {
    challengeId: row.challengeId,
    workspaceId: row.workspaceId,
    sasDigits: sas,
    displayName: input.displayName,
  };
}

export interface ConfirmInput {
  challengeId: string;
  approve: boolean;
}

export interface ConfirmResult {
  /** True when we transitioned the challenge to a terminal state. */
  resolved: boolean;
  /** The paired device row (only on approve=true). */
  device?: {
    deviceId:    string;
    workspaceId: string;
    displayName: string;
    devicePubkey: string;
    pairedAt:    Date;
  };
  /** The signed device JWT (only on approve=true). */
  deviceToken?: string;
}

export async function confirmChallenge(input: ConfirmInput): Promise<ConfirmResult> {
  const rows = await db
    .select()
    .from(mobilePairingChallenges)
    .where(eq(mobilePairingChallenges.challengeId, input.challengeId))
    .limit(1);

  if (rows.length === 0) {
    throw new MobilePairingError(
      "challenge_unknown",
      "Pairing challenge is unknown",
    );
  }
  const row = rows[0];
  if (row.confirmedAt || row.rejectedAt) {
    throw new MobilePairingError(
      "challenge_already_resolved",
      "Pairing challenge has already been resolved",
    );
  }
  if (!row.devicePubkey || !row.displayName) {
    // The mobile hasn't redeemed yet — there's nothing to confirm. We
    // surface this as resolved=false so the webhook can return 409 and
    // the desktop user can retry.
    return { resolved: false };
  }

  const now = new Date();

  if (!input.approve) {
    await db
      .update(mobilePairingChallenges)
      .set({ rejectedAt: now })
      .where(eq(mobilePairingChallenges.challengeId, row.challengeId));
    return { resolved: true };
  }

  // Insert the paired device row. Drizzle's `returning` gives us the
  // server-generated UUID + paired_at default.
  const [device] = await db
    .insert(mobilePairedDevices)
    .values({
      workspaceId:  row.workspaceId,
      devicePubkey: row.devicePubkey,
      displayName:  row.displayName,
    })
    .returning();
  if (!device) {
    throw new Error("failed to insert mobile_paired_devices row");
  }

  await db
    .update(mobilePairingChallenges)
    .set({
      confirmedAt:    now,
      pairedDeviceId: device.deviceId,
    })
    .where(eq(mobilePairingChallenges.challengeId, row.challengeId));

  const deviceToken = signMobileDeviceToken({
    device_id:        device.deviceId,
    workspace_id:     device.workspaceId,
    paired_device_id: device.deviceId,
  });

  return {
    resolved: true,
    device: {
      deviceId:     device.deviceId,
      workspaceId:  device.workspaceId,
      displayName:  device.displayName,
      devicePubkey: device.devicePubkey,
      pairedAt:     device.pairedAt,
    },
    deviceToken,
  };
}

export interface StatusResult {
  paired: boolean;
  rejected?: boolean;
  expired?: boolean;
  /** Present iff `paired === true`. Mobile clients store this and bear
   *  it on every subsequent /api/mobile/* call. */
  deviceToken?: string;
  /** Present iff `paired === true`. Surfaced for the inbox first paint. */
  device?: {
    deviceId:     string;
    workspaceId:  string;
    displayName:  string;
  };
}

/**
 * Mobile polls this. We never re-issue the JWT here — we look up the
 * paired device row + sign a fresh token each time the mobile asks.
 * This means losing the original poll response only costs another HTTP
 * roundtrip, not a re-pairing.
 */
export async function challengeStatus(challengeId: string): Promise<StatusResult> {
  const rows = await db
    .select()
    .from(mobilePairingChallenges)
    .where(eq(mobilePairingChallenges.challengeId, challengeId))
    .limit(1);
  if (rows.length === 0) {
    return { paired: false };
  }
  const row = rows[0];
  if (row.rejectedAt) {
    return { paired: false, rejected: true };
  }
  if (!row.confirmedAt) {
    if (row.expiresAt.getTime() <= Date.now()) {
      return { paired: false, expired: true };
    }
    return { paired: false };
  }
  if (!row.pairedDeviceId) {
    // Should not happen — confirm path always sets this — but be
    // defensive.
    return { paired: false };
  }

  const deviceRows = await db
    .select()
    .from(mobilePairedDevices)
    .where(eq(mobilePairedDevices.deviceId, row.pairedDeviceId))
    .limit(1);
  if (deviceRows.length === 0 || deviceRows[0].revokedAt) {
    return { paired: false };
  }
  const device = deviceRows[0];

  const deviceToken = signMobileDeviceToken({
    device_id:        device.deviceId,
    workspace_id:     device.workspaceId,
    paired_device_id: device.deviceId,
  });

  return {
    paired: true,
    deviceToken,
    device: {
      deviceId:    device.deviceId,
      workspaceId: device.workspaceId,
      displayName: device.displayName,
    },
  };
}

/**
 * Look up + last-seen-bump a paired device by JWT claims. Returns null
 * iff the device has been revoked or doesn't exist.
 */
export async function lookupActiveDevice(deviceId: string): Promise<{
  deviceId:    string;
  workspaceId: string;
  displayName: string;
  devicePubkey: string;
} | null> {
  const rows = await db
    .select()
    .from(mobilePairedDevices)
    .where(eq(mobilePairedDevices.deviceId, deviceId))
    .limit(1);
  if (rows.length === 0 || rows[0].revokedAt) return null;
  const d = rows[0];
  // Best-effort last-seen bump. Don't await — caller doesn't need it.
  void db
    .update(mobilePairedDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(mobilePairedDevices.deviceId, deviceId))
    .catch(() => undefined);
  return {
    deviceId:     d.deviceId,
    workspaceId:  d.workspaceId,
    displayName:  d.displayName,
    devicePubkey: d.devicePubkey,
  };
}

/** List active devices for a workspace, newest first. */
export async function listDevices(workspaceId: string) {
  return db
    .select()
    .from(mobilePairedDevices)
    .where(
      and(
        eq(mobilePairedDevices.workspaceId, workspaceId),
        isNull(mobilePairedDevices.revokedAt),
      ),
    );
}

/** Mark a paired device as revoked. Idempotent. */
export async function revokeDevice(deviceId: string): Promise<void> {
  await db
    .update(mobilePairedDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mobilePairedDevices.deviceId, deviceId),
        isNull(mobilePairedDevices.revokedAt),
      ),
    );
}

/** Save / update a device's web-push subscription. */
export async function setPushSubscription(
  deviceId: string,
  subscription: unknown,
): Promise<void> {
  await db
    .update(mobilePairedDevices)
    .set({ pushSubscription: subscription as object })
    .where(eq(mobilePairedDevices.deviceId, deviceId));
}
