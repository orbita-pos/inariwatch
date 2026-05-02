// Web-side helper that mints user JWTs for the WS relay (v0.3 S2).
//
// Per INARI_AI_ARCHITECTURE.md §4.4: the user's JWT is issued by web at
// Inari Live login (Tauri callback URL) and embedded in the relay WS
// handshake. Algorithm + claims are mirrored 1:1 by the relay's
// Go-side `verifyJWT` (services/relay/auth.go).
//
// HS256, claims = { sub: userId, exp, iat, iss = "inariwatch-web" }.
// Key = SHA-256("inariwatch-relay-jwt:" || INARI_LIVE_RELAY_JWT_KEY).

import { createHash, createHmac } from "crypto";

const ISS = "inariwatch-web";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export class RelayJWTConfigMissing extends Error {
  constructor() {
    super("INARI_LIVE_RELAY_JWT_KEY not set");
    this.name = "RelayJWTConfigMissing";
  }
}

function deriveKey(seed: string): Buffer {
  return createHash("sha256")
    .update("inariwatch-relay-jwt:" + seed)
    .digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Sign a relay JWT for `userId`. Defaults to a 30-day expiry, matching
 * Tauri "stay logged in" UX. Pass `ttlSeconds` to override (e.g. for
 * one-shot test tokens with a short window).
 */
export function signRelayJWT(
  userId: string,
  opts: { ttlSeconds?: number; seed?: string } = {},
): string {
  const seed = opts.seed ?? process.env.INARI_LIVE_RELAY_JWT_KEY;
  if (!seed) throw new RelayJWTConfigMissing();
  const key = deriveKey(seed);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = { sub: userId, iat, exp, iss: ISS };
  const headerJSON = b64url(Buffer.from(JSON.stringify(header)));
  const claimsJSON = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = headerJSON + "." + claimsJSON;
  const sig = b64url(createHmac("sha256", key).update(signingInput).digest());
  return signingInput + "." + sig;
}
