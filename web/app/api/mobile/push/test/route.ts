/**
 * S12 — POST /api/mobile/push/test
 *
 * Bearer-authed. Fires a test web-push to the calling device's stored
 * subscription. Useful for the PWA's "is push set up correctly?" UX.
 *
 * If VAPID keys are not configured, we 503 — the user-facing copy
 * tells them to ask the workspace owner to wire VAPID keys (see
 * `web/.env.example`).
 */

import { NextResponse, type NextRequest } from "next/server";
import webpush from "web-push";
import { db, mobilePairedDevices } from "@/lib/db";
import { eq } from "drizzle-orm";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";

interface PushSubShape {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?:   string;
  };
}

export async function POST(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;

  const publicKey  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact    = process.env.VAPID_EMAIL ?? "mailto:noreply@inariwatch.com";
  if (!publicKey || !privateKey) {
    return NextResponse.json(
      {
        error: "push_not_configured",
        message:
          "Web push not configured on this server. Workspace owner: set VAPID_PRIVATE_KEY + NEXT_PUBLIC_VAPID_PUBLIC_KEY.",
      },
      { status: 503 },
    );
  }
  webpush.setVapidDetails(contact, publicKey, privateKey);

  const rows = await db
    .select()
    .from(mobilePairedDevices)
    .where(eq(mobilePairedDevices.deviceId, device.deviceId))
    .limit(1);
  const sub = rows[0]?.pushSubscription as PushSubShape | null;
  if (!sub || !sub.endpoint) {
    return NextResponse.json(
      { error: "no_subscription", message: "No push subscription stored — subscribe first." },
      { status: 409 },
    );
  }

  try {
    await webpush.sendNotification(
      sub as webpush.PushSubscription,
      JSON.stringify({
        title: "Inari test push",
        body:  "Push notifications are wired up.",
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: "push_failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
