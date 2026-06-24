/**
 * S12 — POST /api/mobile/push/subscribe
 *
 * Mobile sends its W3C `PushSubscription` JSON. We persist it on the
 * paired device row. S12 itself does NOT fire pushes server-side
 * (deferred to S12.5 — the policy + alert routing piece is being
 * shipped by S10 in parallel and this endpoint just captures the
 * subscription so S10 can send to it once it lands).
 */

import { NextResponse, type NextRequest } from "next/server";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";
import { setPushSubscription } from "@/lib/services/mobile-pairing.service";

export const runtime = "nodejs";

interface SubscribeBody {
  subscription?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;

  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const sub = body.subscription;
  if (
    !sub ||
    typeof sub !== "object" ||
    typeof (sub as { endpoint?: unknown }).endpoint !== "string"
  ) {
    return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
  }
  await setPushSubscription(device.deviceId, sub);
  return NextResponse.json({ ok: true });
}
