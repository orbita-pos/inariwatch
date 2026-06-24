import { NextRequest, NextResponse } from "next/server";
import { db, deviceTokens, getUserOrganizations, users } from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import { authenticateExtensionToken } from "@/lib/auth-extension";

/**
 * GET /api/desktop/me
 *
 * Bearer-authenticated self-info endpoint for Inari Live. Used by the
 * desktop app on launch to:
 *   - Validate the cached token (401 = re-pair needed)
 *   - Render this device's row in Settings → Devices
 *   - Show the workspace email in Settings → Account
 *
 * Pre-S1 desktop installs (legacy api_keys row) authenticate here too,
 * but `deviceId` and `device` will be null for them — frontend should
 * gracefully degrade to "Connected" without per-device detail.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateExtensionToken(req);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [user] = await db
    .select({
      id:          users.id,
      email:       users.email,
      name:        users.name,
      activeOrgId: users.activeOrgId,
    })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Resolve the user's primary workspace. Order of precedence:
  //   1. `users.activeOrgId` — what the dashboard's workspace switcher
  //      currently has selected.
  //   2. Any org the user owns OR is a member of (via
  //      `getUserOrganizations`, which unions `organizations.ownerId`
  //      with `organization_members`). Pre-V1.5 the fallback only
  //      checked ownership, so users who were members-only of their
  //      single workspace got `workspaceId: null` here, which broke
  //      Channels pairing on Inari Live with "no workspace selected
  //      — finish desktop login first" forever.
  //   3. `null` — legitimate Personal-only user with zero orgs. The
  //      desktop side gracefully degrades.
  let workspaceId: string | null = user.activeOrgId ?? null;
  if (!workspaceId) {
    const orgs = await getUserOrganizations(user.id);
    if (orgs.length > 0) workspaceId = orgs[0].id;
  }

  let device: {
    deviceId: string;
    label: string;
    os: string | null;
    hostname: string | null;
    appVersion: string | null;
    createdAt: string;
    lastSeenAt: string;
  } | null = null;

  if (auth.deviceId) {
    const [row] = await db
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
      .where(and(eq(deviceTokens.deviceId, auth.deviceId), isNull(deviceTokens.revokedAt)))
      .limit(1);

    if (row) {
      device = {
        deviceId:   row.deviceId,
        label:      row.label,
        os:         row.os,
        hostname:   row.hostname,
        appVersion: row.appVersion,
        createdAt:  row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      };
    }
  }

  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    workspaceId,
    device,
  });
}
