import { NextRequest, NextResponse } from "next/server";
import { db, deviceTokens } from "@/lib/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveDesktopActor } from "@/lib/auth-extension";

/**
 * POST /api/desktop/devices/sign-out-all
 *
 * Revoke EVERY active device_tokens row for the calling user. Decoupled
 * from project tokens by design — Session 1 brief: "Revokes device tokens
 * only. Project tokens (in user's host env vars) untouched."
 *
 * Returns the number of rows revoked so the caller can render a confirm
 * toast like "3 devices signed out."
 */
export async function POST(req: NextRequest) {
  const auth = await resolveDesktopActor(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await db
    .update(deviceTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(deviceTokens.userId, auth.userId), isNull(deviceTokens.revokedAt)))
    .returning({ deviceId: deviceTokens.deviceId });

  return NextResponse.json({ ok: true, revokedCount: result.length });
}
