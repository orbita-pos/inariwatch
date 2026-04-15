import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { analyzeReplay } from "@/lib/jobs/replay-analyze";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Haiku + fetch-from-R2 + DB update fits comfortably in 60s. */
export const maxDuration = 120;

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/replay/[sessionId]/analyze
 *
 * Internal endpoint — called by the BullMQ worker (with Bearer CRON_SECRET)
 * after a session's final block arrives. Idempotent; safe to retry.
 *
 * Body (optional): { force: boolean } — re-runs even if aiSummary is set.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  // Bearer auth with timing-safe compare (matches existing internal endpoints)
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const received = Buffer.from(auth);
  const valid = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  if (!valid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  if (!sessionId || sessionId.length > 128) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }

  let force = false;
  try {
    const body = await req.json();
    if (body && typeof body === "object" && body.force === true) force = true;
  } catch {
    // Empty body is fine
  }

  try {
    const result = await analyzeReplay(sessionId, { force });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[replay/analyze] ${sessionId} failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
