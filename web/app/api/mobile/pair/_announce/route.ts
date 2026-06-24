/**
 * S12 — POST /api/mobile/pair/_announce  (CRON_SECRET bearered)
 *
 * Desktop announces a freshly-generated Crockford code so the web has
 * a row to validate against when the mobile redeems. Underscore-
 * prefixed because this is a private webhook, not a mobile-app
 * endpoint.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  announceChallenge,
  MobilePairingError,
} from "@/lib/services/mobile-pairing.service";
import { authoriseDesktopWebhook } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";

interface AnnounceBody {
  workspace_id?:   unknown;
  pairing_code?:   unknown;
  created_at_ms?:  unknown;
  expires_at_ms?:  unknown;
}

export async function POST(req: NextRequest) {
  const auth = authoriseDesktopWebhook(req);
  if (!auth.ok) return auth.response;

  let body: AnnounceBody;
  try {
    body = (await req.json()) as AnnounceBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { workspace_id, pairing_code, created_at_ms, expires_at_ms } = body;
  if (
    typeof workspace_id !== "string" ||
    typeof pairing_code !== "string" ||
    typeof created_at_ms !== "number"
  ) {
    return NextResponse.json(
      { error: "invalid_body", message: "workspace_id, pairing_code, created_at_ms required" },
      { status: 400 },
    );
  }

  try {
    const out = await announceChallenge({
      workspaceId: workspace_id,
      pairingCode: pairing_code,
      createdAtMs: created_at_ms,
      expiresAtMs: typeof expires_at_ms === "number" ? expires_at_ms : undefined,
    });
    return NextResponse.json({ challenge_id: out.challengeId });
  } catch (e) {
    if (e instanceof MobilePairingError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    }
    console.warn("[mobile-pair/_announce]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
