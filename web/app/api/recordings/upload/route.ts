import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { substrateRecordings, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

// Note: CRON_SECRET is a single shared secret for all CLI users.
// If one user's config leaks, all CLI upload auth is compromised.
// Future: migrate to per-user API tokens (like MCP uses hashed bearer tokens).
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

  // Rate limiting
  const { checkWebhookRateLimit, extractClientIp } = await import("@/lib/webhooks/rate-limit");
  const ip = extractClientIp(req);
  const rl = await checkWebhookRateLimit(ip);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Body size limit (500KB)
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > 500_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
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
      uiEvents,
    } = body;

    if (!recordingId) {
      return NextResponse.json(
        { error: "recordingId is required" },
        { status: 400 }
      );
    }

    // Size validation for uiEvents (max 5000 events to prevent OOM/DB bloat)
    if (Array.isArray(uiEvents) && uiEvents.length > 5000) {
      return NextResponse.json(
        { error: "uiEvents exceeds max 5000 events" },
        { status: 400 }
      );
    }

    // Validate project ownership (session users only — CLI uses bearer token which is trusted)
    if (session?.user && projectId) {
      const userId = (session.user as { id?: string }).id;
      const [proj] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId!)))
        .limit(1);
      if (!proj) {
        return NextResponse.json({ error: "Project not found or not owned by you" }, { status: 403 });
      }
    }

    // Upsert — allow re-uploading the same recording.
    const existing = await db
      .select({ id: substrateRecordings.id, projectId: substrateRecordings.projectId })
      .from(substrateRecordings)
      .where(eq(substrateRecordings.recordingId, recordingId))
      .limit(1);

    if (existing.length > 0) {
      // Verify ownership for session users on update path
      if (session?.user && existing[0]) {
        const userId = (session.user as { id?: string }).id;
        const existingProjectId = (existing[0] as { projectId?: string }).projectId;
        if (existingProjectId && userId) {
          const [proj] = await db.select({ id: projects.id }).from(projects)
            .where(and(eq(projects.id, existingProjectId), eq(projects.userId, userId)))
            .limit(1);
          if (!proj) {
            return NextResponse.json({ error: "Recording not found or not owned by you" }, { status: 403 });
          }
        }
      }
      await db
        .update(substrateRecordings)
        .set({
          alertId: alertId || null,
          projectId: projectId || null,
          context: context || null,
          events: events || null,
          uiEvents: uiEvents || null,
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
      uiEvents: uiEvents || null,
    });

    return NextResponse.json({
      ok: true,
      recordingId,
      alertId: alertId || null,
      url: alertId ? `/alerts/${alertId}` : null,
    });
  } catch (error: unknown) {
    console.error("[recordings/upload]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
