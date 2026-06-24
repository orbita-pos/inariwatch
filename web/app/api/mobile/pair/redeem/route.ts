/**
 * S12 — POST /api/mobile/pair/redeem
 *
 * Mobile sends `{ code, device_pubkey, display_name }`. We validate
 * the code against `mobile_pairing_challenges`, derive a 6-digit SAS,
 * persist it, and return `{ sas_challenge_id, sas_digits }`. The
 * desktop sees the same digits via SSE on the relay (handled by the
 * desktop's relay-listener; the web side fires the announcement via
 * `notifyDesktopSasShown` below — currently a stub that logs the
 * payload until the relay's reverse-direction publish endpoint lands
 * in S12.5).
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  redeemCode,
  MobilePairingError,
} from "@/lib/services/mobile-pairing.service";
import { rateLimit } from "@/lib/auth-rate-limit";
import { extractClientIp } from "@/lib/webhooks/rate-limit";
import { notifyDesktopSasShown } from "@/lib/services/mobile-relay.service";

export const runtime = "nodejs";

interface RedeemBody {
  code?: unknown;
  device_pubkey?: unknown;
  display_name?: unknown;
}

export async function POST(req: NextRequest) {
  const ip = extractClientIp(req);
  const limit = await rateLimit("mobile-pair-redeem", ip, { windowMs: 60_000, max: 3 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: limit.retryAfterSeconds ?? 60 },
      { status: 429 },
    );
  }

  let body: RedeemBody;
  try {
    body = (await req.json()) as RedeemBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { code, device_pubkey, display_name } = body;
  if (typeof code !== "string" || typeof device_pubkey !== "string" || typeof display_name !== "string") {
    return NextResponse.json(
      { error: "invalid_body", message: "code, device_pubkey, display_name are required strings" },
      { status: 400 },
    );
  }
  if (device_pubkey.length < 16 || device_pubkey.length > 256) {
    return NextResponse.json({ error: "invalid_pubkey" }, { status: 400 });
  }
  if (display_name.length < 1 || display_name.length > 80) {
    return NextResponse.json({ error: "invalid_display_name" }, { status: 400 });
  }

  try {
    const result = await redeemCode({
      code,
      devicePubkey: device_pubkey,
      displayName:  display_name,
    });
    // Best-effort: notify desktop. We fire-and-forget — the desktop
    // user can also just look at the mobile screen + retype the code
    // if the relay is offline.
    void notifyDesktopSasShown({
      workspaceId:        result.workspaceId,
      challengeId:        result.challengeId,
      sasDigits:          result.sasDigits,
      deviceDisplayName:  result.displayName,
    });
    return NextResponse.json({
      sas_challenge_id: result.challengeId,
      sas_digits:       result.sasDigits,
    });
  } catch (e) {
    if (e instanceof MobilePairingError) {
      const status = mapMobileErrorStatus(e.code);
      return NextResponse.json({ error: e.code, message: e.message }, { status });
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

function mapMobileErrorStatus(code: MobilePairingError["code"]): number {
  switch (code) {
    case "code_invalid":            return 400;
    case "code_unknown":            return 404;
    case "code_expired":            return 410;
    case "code_already_redeemed":   return 409;
    case "challenge_unknown":       return 404;
    case "challenge_already_resolved": return 409;
  }
}
