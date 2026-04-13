import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, users, PLAN_LIMITS } from "@/lib/db";
import { substrateRecordings, projects } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import crypto from "crypto";

// Per-user storage caps. Compute-on-demand from substrate_recordings — no
// counter to maintain. The (user_id) index on substrate_recordings makes
// the SUM query single-digit ms at typical sizes.
const STORAGE_CAP_BYTES: Record<string, number> = {
  free: 100 * 1024 * 1024,           // 100 MB
  pro: 5 * 1024 * 1024 * 1024,       // 5 GB
  team: 5 * 1024 * 1024 * 1024,      // 5 GB
};

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

    // Resolve which user owns this recording (for storage attribution +
    // ownership verification). Session path uses the session user; bearer
    // path looks up the project's owner — bearer is a shared CLI secret
    // and was previously fully trusted, so this closes that gap too.
    let storageUserId: string | null = null;
    let storagePlan: string = "free";

    if (session?.user) {
      const sessionUserId = (session.user as { id?: string }).id ?? null;
      if (!sessionUserId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      storageUserId = sessionUserId;

      if (projectId) {
        const [proj] = await db
          .select({ id: projects.id, plan: users.plan })
          .from(projects)
          .innerJoin(users, eq(projects.userId, users.id))
          .where(and(eq(projects.id, projectId), eq(projects.userId, sessionUserId)))
          .limit(1);
        if (!proj) {
          return NextResponse.json({ error: "Project not found or not owned by you" }, { status: 403 });
        }
        storagePlan = "pro"; // Beta: all users get Pro storage limits
      } else {
        storagePlan = "pro"; // Beta: all users get Pro storage limits
      }
    } else {
      // Bearer path. Require projectId so we can attribute storage and
      // verify the project actually exists (no more blanket trust).
      if (!projectId) {
        return NextResponse.json(
          { error: "projectId is required for bearer uploads" },
          { status: 400 }
        );
      }
      const [proj] = await db
        .select({ userId: projects.userId, plan: users.plan })
        .from(projects)
        .innerJoin(users, eq(projects.userId, users.id))
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!proj) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      storageUserId = proj.userId;
      storagePlan = "pro"; // Beta: all users get Pro storage limits
    }

    // Per-user storage cap. Compute-on-demand SUM(LENGTH(...)). Single-digit
    // ms with the existing (user_id) index. Skip cap check if no events
    // payload (metadata-only update).
    const newSize =
      (events ? JSON.stringify(events).length : 0) +
      (uiEvents ? JSON.stringify(uiEvents).length : 0);
    if (newSize > 0 && storageUserId) {
      const cap = STORAGE_CAP_BYTES[storagePlan] ?? STORAGE_CAP_BYTES.free;
      const sumResult = await db.execute<{ used: string | number | null }>(sql`
        SELECT COALESCE(SUM(
          COALESCE(LENGTH(events::text), 0) + COALESCE(LENGTH(ui_events::text), 0)
        ), 0)::bigint AS used
        FROM substrate_recordings sr
        INNER JOIN projects p ON sr.project_id = p.id
        WHERE p.user_id = ${storageUserId}
      `);
      const used = Number(sumResult.rows[0]?.used ?? 0);
      if (used + newSize > cap) {
        const usedMb = Math.round(used / 1_048_576);
        const capMb = Math.round(cap / 1_048_576);
        return NextResponse.json(
          {
            error: `Storage cap reached (${usedMb} MB / ${capMb} MB). Upgrade to Pro for 5 GB.`,
          },
          { status: 413 }
        );
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
