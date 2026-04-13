import { NextResponse } from "next/server";
import crypto from "crypto";
import { db, alerts, substrateRecordings } from "@/lib/db";
import { eq } from "drizzle-orm";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/alerts/post-process
 *
 * Called by the Hetzner worker after an alert is created.
 * Handles async operations that need web-only deps (AI client, Slack, etc).
 *
 * Actions:
 *   auto-analyze       — AI diagnosis of the alert
 *   substrate-insert   — save substrate recording
 *   outgoing-webhooks  — dispatch to user's configured webhooks
 *   status-incident    — auto-create status page incident
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

  const body = await req.json();
  const { action, alertId } = body as { action: string; alertId: string };

  if (!action || !alertId) {
    return NextResponse.json({ error: "Missing action or alertId" }, { status: 400 });
  }

  try {
    switch (action) {
      case "auto-analyze": {
        const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
        if (alert) {
          const { autoAnalyzeAlert } = await import("@/lib/ai/auto-analyze");
          // Fire-and-forget — respond immediately
          autoAnalyzeAlert(alert).catch(() => {});
        }
        break;
      }

      case "substrate-insert": {
        const { recording, projectId } = body as {
          recording: {
            recordingId: string;
            events: unknown;
            uiEvents?: unknown;
            context?: string;
            eventCount?: number;
            categories?: unknown;
            durationMs?: number;
          };
          projectId: string;
        };
        if (recording?.recordingId) {
          await db.insert(substrateRecordings).values({
            recordingId: recording.recordingId,
            alertId,
            projectId,
            events: recording.events,
            uiEvents: recording.uiEvents,
            context: recording.context,
            eventCount: recording.eventCount,
            categories: recording.categories,
            durationMs: recording.durationMs,
          }).onConflictDoNothing();
        }
        break;
      }

      case "outgoing-webhooks": {
        const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
        if (alert) {
          const { dispatchOutgoingWebhooks } = await import("@/lib/webhooks/outgoing");
          dispatchOutgoingWebhooks(alert, "alert.created").catch(() => {});
        }
        break;
      }

      case "status-incident": {
        const { projectId } = body as { projectId: string };
        const { autoCreateIncident } = await import("@/lib/ai/status-page-automation");
        autoCreateIncident({
          projectId,
          alertId,
          alertTitle: "",
          alertSeverity: "critical",
        }).catch(() => {});
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    console.error(`[post-process] ${action} failed:`, err);
    return NextResponse.json({ ok: true, action, warning: "partial failure" });
  }
}
