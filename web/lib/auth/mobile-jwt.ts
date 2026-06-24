/**
 * S12 — HS256 JWT for mobile device sessions.
 *
 * Implemented with Node `crypto` so we don't pull in `jose`/`jsonwebtoken`
 * for one feature. The math is small: header.payload.hmac, all base64url-
 * encoded, signed with HMAC-SHA256 over `header.payload`.
 *
 * Secret comes from `MOBILE_DEVICE_JWT_SECRET` (32-byte hex). Never read
 * client-side — these helpers are server-only.
 */

import crypto from "crypto";

export interface MobileDeviceTokenClaims {
  device_id:        string;
  workspace_id:     string;
  /** UUID of the matching `mobile_paired_devices` row. */
  paired_device_id: string;
  /** Issued-at — epoch seconds. */
  iat: number;
  /** Expiry — epoch seconds. */
  exp: number;
}

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h sliding (matches S12 prompt §2)

function getSecret(): Buffer {
  const raw = process.env.MOBILE_DEVICE_JWT_SECRET;
  if (!raw) {
    throw new Error(
      "MOBILE_DEVICE_JWT_SECRET is not set — required for mobile device auth",
    );
  }
  if (raw.length < 32) {
    throw new Error("MOBILE_DEVICE_JWT_SECRET must be at least 32 chars (hex)");
  }
  // Allow either hex or raw — hex is the documented form, but accept raw
  // for ease of testing.
  if (/^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return Buffer.from(raw, "utf8");
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(s: string): Buffer {
  // Re-pad to length multiple of 4 for atob/Buffer.from to accept.
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(std, "base64");
}

export interface SignOpts {
  /** Override `now` for tests. Epoch seconds. */
  nowSeconds?: number;
  /** Override TTL for tests. */
  ttlSeconds?: number;
}

export function signMobileDeviceToken(
  claims: Omit<MobileDeviceTokenClaims, "iat" | "exp">,
  opts: SignOpts = {},
): string {
  const now = Math.floor(opts.nowSeconds ?? Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? TOKEN_TTL_SECONDS;
  const payload: MobileDeviceTokenClaims = {
    ...claims,
    iat: now,
    exp: now + ttl,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(signingInput)
    .digest();
  const sigB64 = base64UrlEncode(sig);

  return `${signingInput}.${sigB64}`;
}

export interface VerifyResult {
  ok: boolean;
  claims?: MobileDeviceTokenClaims;
  reason?: "format" | "signature" | "expired" | "secret-missing";
}

export function verifyMobileDeviceToken(
  token: string,
  opts: SignOpts = {},
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "format" };
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return { ok: false, reason: "format" };

  let secret: Buffer;
  try {
    secret = getSecret();
  } catch {
    return { ok: false, reason: "secret-missing" };
  }

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const providedSig = base64UrlDecode(sigB64);
  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    return { ok: false, reason: "signature" };
  }

  let claims: MobileDeviceTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as MobileDeviceTokenClaims;
  } catch {
    return { ok: false, reason: "format" };
  }

  const now = Math.floor(opts.nowSeconds ?? Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}

/** Bearer-token extraction from a request — null when missing/malformed. */
export function extractBearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}
