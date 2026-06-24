import { NextRequest, NextResponse } from "next/server";
import { db, deviceTokens } from "@/lib/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { resolveDesktopActor } from "@/lib/auth-extension";

/**
 * GET /api/desktop/devices
 *
 * Returns the caller's active Inari Live devices. Accepts either:
 *   - NextAuth session (web Settings → Devices panel), or
 *   - Bearer device-token (desktop Settings → Devices tab).
 *
 * Both auths resolve to the same userId; the response is scoped to that
 * user and excludes revoked rows. The current row (when called via
 * Bearer) is flagged with `isCurrent: true`.
 */
export async function GET(req: NextRequest) {
  const auth = await resolveDesktopActor(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      deviceId:   deviceTokens.deviceId,
      label:      deviceTokens.label,
      os:         deviceTokens.os,
      hostname:   deviceTokens.hostname,
      appVersion: deviceTokens.appVersion,
      createdAt:  deviceTokens.createdAt,
      lastSeenAt: deviceTokens.lastSeenAt,
    })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, auth.userId), isNull(deviceTokens.revokedAt)))
    .orderBy(desc(deviceTokens.lastSeenAt));

  return NextResponse.json({
    devices: rows.map((r) => ({
      deviceId:   r.deviceId,
      label:      r.label,
      os:         r.os,
      hostname:   r.hostname,
      appVersion: r.appVersion,
      createdAt:  r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      isCurrent:  auth.deviceId === r.deviceId,
    })),
    currentDeviceId: auth.deviceId ?? null,
  });
}
