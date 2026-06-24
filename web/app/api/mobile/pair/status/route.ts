/**
 * S12 — GET /api/mobile/pair/status?challenge_id=X
 *
 * Mobile polls this every ~2s after redeem until paired=true. We
 * don't long-poll / SSE here because the polling cost is trivial
 * (one indexed PK lookup) and works reliably across iOS Safari /
 * Chrome battery savers / strict CSPs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { challengeStatus } from "@/lib/services/mobile-pairing.service";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const challengeId = url.searchParams.get("challenge_id");
  if (!challengeId) {
    return NextResponse.json({ error: "missing_challenge_id" }, { status: 400 });
  }
  // UUID v4 format check — challenge_ids are server-generated UUIDs.
  if (!/^[0-9a-f-]{36}$/i.test(challengeId)) {
    return NextResponse.json({ error: "invalid_challenge_id" }, { status: 400 });
  }
  try {
    const status = await challengeStatus(challengeId);
    if (status.paired) {
      return NextResponse.json({
        paired:       true,
        device_token: status.deviceToken,
        device:       status.device,
      });
    }
    return NextResponse.json({
      paired:   false,
      rejected: !!status.rejected,
      expired:  !!status.expired,
    });
  } catch (e) {
    console.warn("[mobile-pair/status]", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
