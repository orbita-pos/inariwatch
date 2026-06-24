/**
 * S12 — POST /api/mobile/session/refresh
 *
 * Mobile sends its current bearer JWT (in the Authorization header).
 * If it's still valid + the device row is active, we mint a fresh
 * 24h JWT. If the device has been revoked, return 401 — mobile
 * redirects to /mobile/pair.
 */

import { NextResponse, type NextRequest } from "next/server";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";
import { signMobileDeviceToken } from "@/lib/auth/mobile-jwt";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;
  const fresh = signMobileDeviceToken({
    device_id:        device.deviceId,
    workspace_id:     device.workspaceId,
    paired_device_id: device.deviceId,
  });
  return NextResponse.json({ device_token: fresh });
}
