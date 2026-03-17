import { NextResponse } from "next/server";
import { db, notificationLogs } from "@/lib/db";
import { eq, and, isNull } from "drizzle-orm";

const APP_URL = process.env.NEXTAUTH_URL ?? "https://inariwatch.com";

/**
 * GET /api/notifications/track/click?id=<notificationLogId>&url=<destination>
 *
 * Click tracking redirect. Wraps links in alert emails.
 * Records the first click timestamp, then redirects to the real URL.
 *
 * Only redirects to our own domain to prevent open-redirect attacks.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const destination = url.searchParams.get("url");

  if (id) {
    await db
      .update(notificationLogs)
      .set({ clickedAt: new Date() })
      .where(
        and(
          eq(notificationLogs.id, id),
          isNull(notificationLogs.clickedAt)
        )
      );
  }

  // Only allow redirects to our own domain — prevents open-redirect attacks
  const target = destination && isSameOrigin(destination)
    ? destination
    : APP_URL;

  return NextResponse.redirect(target, 302);
}

function isSameOrigin(str: string): boolean {
  try {
    const dest = new URL(str);
    const app = new URL(APP_URL);
    return (
      dest.protocol === "https:" &&
      dest.hostname === app.hostname
    );
  } catch {
    return false;
  }
}
