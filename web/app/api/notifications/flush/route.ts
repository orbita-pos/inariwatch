import { NextResponse } from "next/server";
import crypto from "crypto";
import { processNotificationQueue, processEmailDigests } from "@/lib/notifications/send";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/notifications/flush
 *
 * Called by the Hetzner worker every 30s to process pending notifications.
 * Replaces the inline processNotificationQueue() call in the poll cron.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [queueResult, digestResult] = await Promise.all([
    processNotificationQueue(),
    processEmailDigests(),
  ]);

  return NextResponse.json({
    sent: queueResult.sent + digestResult.sent,
    failed: queueResult.failed + digestResult.failed,
    skipped: queueResult.skipped,
  });
}
