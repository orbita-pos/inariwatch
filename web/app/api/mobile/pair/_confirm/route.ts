/**
 * S12 — POST /api/mobile/pair/_confirm  (CRON_SECRET bearered)
 *
 * Desktop reports the user's Yes/No on the SAS modal. On Yes we
 * insert `mobile_paired_devices`, sign the device JWT, and return
 * the device + token so the desktop can mirror the row in its local
 * `paired_entities` table for the Settings → Channels → Mobile list.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  confirmChallenge,
  MobilePairingError,
} from "@/lib/services/mobile-pairing.service";
import { authoriseDesktopWebhook } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";

interface ConfirmBody {
  challenge_id?: unknown;
  approve?:      unknown;
}

export async function POST(req: NextRequest) {
  const auth = authoriseDesktopWebhook(req);
  if (!auth.ok) return auth.response;

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { challenge_id, approve } = body;
  if (typeof challenge_id !== "string" || typeof approve !== "boolean") {
    return NextResponse.json(
      { error: "invalid_body", message: "challenge_id (uuid), approve (bool) required" },
      { status: 400 },
    );
  }
  try {
    const result = await confirmChallenge({ challengeId: challenge_id, approve });
    if (!result.resolved) {
      // Mobile hasn't redeemed yet — return 409 so the desktop user
      // can ask the mobile to retype the code.
      return NextResponse.json(
        { error: "challenge_pending_redeem" },
        { status: 409 },
      );
    }
    if (!approve) {
      return NextResponse.json({ resolved: true, approved: false });
    }
    return NextResponse.json({
      resolved:     true,
      approved:     true,
      device:       result.device,
      device_token: result.deviceToken,
    });
  } catch (e) {
    if (e instanceof MobilePairingError) {
      const status =
        e.code === "challenge_unknown"          ? 404 :
        e.code === "challenge_already_resolved" ? 409 :
        400;
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    console.warn("[mobile-pair/_confirm]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
