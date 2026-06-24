import { NextRequest, NextResponse } from "next/server";
import { db, deviceTokens } from "@/lib/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isValidUUID, resolveDesktopActor } from "@/lib/auth-extension";

/**
 * PATCH /api/desktop/devices/[deviceId]
 *
 * Rename a device. Body: { label: string }. Empty/whitespace-only labels
 * fall back to "Inari Live" so the row never has an unrenderable name.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ deviceId: string }> },
) {
  const auth = await resolveDesktopActor(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { deviceId } = await ctx.params;
  if (!isValidUUID(deviceId)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawLabel = typeof (body as { label?: unknown })?.label === "string"
    ? ((body as { label: string }).label as string)
    : "";
  const label = rawLabel.trim().slice(0, 64) || "Inari Live";

  const updated = await db
    .update(deviceTokens)
    .set({ label })
    .where(
      and(
        eq(deviceTokens.deviceId, deviceId),
        eq(deviceTokens.userId, auth.userId),
        isNull(deviceTokens.revokedAt),
      ),
    )
    .returning({ deviceId: deviceTokens.deviceId, label: deviceTokens.label });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  return NextResponse.json({ deviceId: updated[0].deviceId, label: updated[0].label });
}

/**
 * DELETE /api/desktop/devices/[deviceId]
 *
 * Revoke a device. Sets `revoked_at = now()`. Idempotent — already-revoked
 * rows return the same 200 so the desktop's best-effort logout doesn't
 * surface confusing errors when the row was already cleaned up server-side.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ deviceId: string }> },
) {
  const auth = await resolveDesktopActor(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { deviceId } = await ctx.params;
  if (!isValidUUID(deviceId)) {
    return NextResponse.json({ error: "Invalid device id" }, { status: 400 });
  }

  const result = await db
    .update(deviceTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(deviceTokens.deviceId, deviceId),
        eq(deviceTokens.userId, auth.userId),
        isNull(deviceTokens.revokedAt),
      ),
    )
    .returning({ deviceId: deviceTokens.deviceId });

  // Fall through to "ok" even when no row matched — could be already revoked.
  return NextResponse.json({ ok: true, revoked: result.length > 0 });
}
