/**
 * GET /api/desktop/relay/jwt
 *
 * Inari Live V1 — Session 3. Issues a fresh relay-WS JWT to the
 * authenticated desktop install so it can register with
 * relay.inariwatch.com and start receiving dispatched tasks (today:
 * `notify.compose.*`, `voice.tts.*`, and `project.wizard.open`).
 *
 * The web JWT helper exists since v0.3 S2 (`web/lib/relay/jwt.ts`) but
 * had no caller — the desktop relay client never had a fetch path to
 * mint one. S3 wires that loop closed.
 *
 * Auth: device Bearer token (S1 keyring → web's `authenticateExtensionToken`).
 *
 * Returns:
 *   { jwt: "<HS256 token>", expiresIn: 30d-in-seconds, relayUrl: "wss://..." }
 *
 * The desktop caches the token in its OS keyring next to the auth
 * bearer (S1 SecretStore) and re-fetches when expiry approaches. The
 * relay server's verifyJWT (services/relay/auth.go) trusts any token
 * minted with the shared secret — no separate device-revocation path
 * because the device bearer was already verified to mint it.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateExtensionToken } from "@/lib/auth-extension";
import {
  RelayJWTConfigMissing,
  signRelayJWT,
} from "@/lib/relay/jwt";

export const runtime = "nodejs";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches signRelayJWT default

export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let jwt: string;
  try {
    jwt = signRelayJWT(auth.userId);
  } catch (err) {
    if (err instanceof RelayJWTConfigMissing) {
      return NextResponse.json(
        {
          error: "relay_disabled",
          message:
            "Relay infrastructure is not configured on this server (INARI_LIVE_RELAY_JWT_KEY missing). Wizard auto-open via WS will be unavailable.",
        },
        { status: 501 },
      );
    }
    throw err;
  }

  const relayUrl =
    process.env.RELAY_WS_URL ??
    process.env.RELAY_URL?.replace(/^http/, "ws") ??
    "wss://relay.inariwatch.com";

  return NextResponse.json({
    jwt,
    expiresIn: DEFAULT_TTL_SECONDS,
    relayUrl,
  });
}
