import { db, notificationLogs } from "@/lib/db";
import { eq, and, isNull } from "drizzle-orm";

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/**
 * GET /api/notifications/track/open?id=<notificationLogId>
 *
 * Tracking pixel endpoint. Embedded as an <img> in alert emails.
 * Records the first open timestamp.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    // Only update if not already opened (first open wins)
    await db
      .update(notificationLogs)
      .set({ openedAt: new Date() })
      .where(
        and(
          eq(notificationLogs.id, id),
          isNull(notificationLogs.openedAt)
        )
      );
  }

  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
