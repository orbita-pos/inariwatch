import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { substrateRecordings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/recordings/upload
 *
 * Receives a Substrate recording from the CLI (`substrate upload`)
 * and stores it for use in InariWatch's remediation pipeline.
 * Requires session auth (web) or Bearer CRON_SECRET (CLI).
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const auth = req.headers.get("authorization");
  const validBearer = CRON_SECRET && auth
    && Buffer.from(`Bearer ${CRON_SECRET}`).length === Buffer.from(auth).length
    && crypto.timingSafeEqual(Buffer.from(`Bearer ${CRON_SECRET}`), Buffer.from(auth));
  if (!session?.user && !validBearer) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const {
      recordingId,
      alertId,
      projectId,
      command,
      runtime,
      startedAt,
      endedAt,
      eventCount,
      durationMs,
      categories,
      context,
      events,
    } = body;

    if (!recordingId) {
      return NextResponse.json(
        { error: "recordingId is required" },
        { status: 400 }
      );
    }

    // Upsert — allow re-uploading the same recording.
    const existing = await db
      .select({ id: substrateRecordings.id })
      .from(substrateRecordings)
      .where(eq(substrateRecordings.recordingId, recordingId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(substrateRecordings)
        .set({
          alertId: alertId || null,
          projectId: projectId || null,
          context: context || null,
          events: events || null,
          eventCount: eventCount || 0,
          durationMs: durationMs || null,
          categories: categories || null,
          updatedAt: new Date(),
        })
        .where(eq(substrateRecordings.recordingId, recordingId));

      return NextResponse.json({
        ok: true,
        recordingId,
        alertId: alertId || null,
        url: `/alerts/${alertId}`,
      });
    }

    // Insert new recording.
    await db.insert(substrateRecordings).values({
      recordingId,
      alertId: alertId || null,
      projectId: projectId || null,
      command: Array.isArray(command) ? command.join(" ") : command,
      runtime: runtime || "node",
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      endedAt: endedAt ? new Date(endedAt) : null,
      eventCount: eventCount || 0,
      durationMs: durationMs || null,
      categories: categories || null,
      context: context || null,
      events: events || null,
    });

    return NextResponse.json({
      ok: true,
      recordingId,
      alertId: alertId || null,
      url: alertId ? `/alerts/${alertId}` : null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[recordings/upload]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
