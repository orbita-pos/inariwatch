/**
 * S12 — middleware-style helper for `/api/mobile/*` routes.
 *
 * Verifies the bearer JWT, ensures the paired device row still exists
 * + isn't revoked, and returns the resolved device. On any failure
 * mode the route gets a `Response` to return verbatim.
 */

import { NextResponse } from "next/server";
import { extractBearer, verifyMobileDeviceToken } from "@/lib/auth/mobile-jwt";
import { lookupActiveDevice } from "@/lib/services/mobile-pairing.service";

export interface AuthorisedDevice {
  deviceId:     string;
  workspaceId:  string;
  displayName:  string;
}

export type AuthResult =
  | { ok: true; device: AuthorisedDevice }
  | { ok: false; response: Response };

export async function authoriseMobileRequest(req: Request): Promise<AuthResult> {
  const token = extractBearer(req);
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  const verified = verifyMobileDeviceToken(token);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "token_expired", message: "device token expired — refresh or re-pair" },
          { status: 401 },
        ),
      };
    }
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  const claims = verified.claims!;
  const active = await lookupActiveDevice(claims.device_id);
  if (!active || active.workspaceId !== claims.workspace_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "device_revoked", message: "device pairing has been revoked — re-pair" },
        { status: 401 },
      ),
    };
  }
  return {
    ok: true,
    device: {
      deviceId:    active.deviceId,
      workspaceId: active.workspaceId,
      displayName: active.displayName,
    },
  };
}

/** CRON_SECRET-style bearer check for desktop → web webhooks. */
export function authoriseDesktopWebhook(req: Request): { ok: true } | { ok: false; response: Response } {
  const token = extractBearer(req);
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "server_misconfigured", message: "CRON_SECRET not set" },
        { status: 500 },
      ),
    };
  }
  if (!token || token !== expected) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true };
}
