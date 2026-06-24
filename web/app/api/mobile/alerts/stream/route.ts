/**
 * S12 — GET /api/mobile/alerts/stream  (SSE)
 *
 * Bearer-authed. Emits one `alert` event per recent alert in the
 * device's workspace, then polls the DB every 5s for new rows. We
 * don't wire LISTEN/NOTIFY in S12 — the relay is the future home of
 * realtime push. The 5s tick is plenty for a phone-side inbox UX.
 */

import { type NextRequest } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { and, eq, gt, inArray, desc } from "drizzle-orm";
import { authoriseMobileRequest } from "@/lib/auth/mobile-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 5_000;

interface AlertOut {
  id:                 string;
  title:              string;
  body:               string;
  severity:           string;
  ai_reasoning:       string | null;
  source_integrations: string[];
  is_read:            boolean;
  is_resolved:        boolean;
  fingerprint:        string | null;
  project_id:         string;
  created_at:         string;
}

function serialiseAlert(a: typeof alerts.$inferSelect): AlertOut {
  return {
    id:                  a.id,
    title:               a.title,
    body:                a.body,
    severity:            a.severity,
    ai_reasoning:        a.aiReasoning ?? null,
    source_integrations: a.sourceIntegrations,
    is_read:             a.isRead,
    is_resolved:         a.isResolved,
    fingerprint:         a.fingerprint ?? null,
    project_id:          a.projectId,
    created_at:          a.createdAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const auth = await authoriseMobileRequest(req);
  if (!auth.ok) return auth.response;
  const { device } = auth;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Initial backlog: 20 most-recent unresolved alerts in the workspace.
      const projectsInWs = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organizationId, device.workspaceId));
      const projectIds = projectsInWs.map((p) => p.id);
      if (projectIds.length === 0) {
        send("ready", { count: 0 });
      } else {
        const initial = await db
          .select()
          .from(alerts)
          .where(inArray(alerts.projectId, projectIds))
          .orderBy(desc(alerts.createdAt))
          .limit(20);
        send("ready", { count: initial.length });
        for (const a of initial.reverse()) {
          send("alert", serialiseAlert(a));
        }
      }

      // Poll loop.
      let lastSeen = new Date();
      let stopped = false;
      const stop = () => { stopped = true; };
      req.signal.addEventListener("abort", stop);

      while (!stopped) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stopped) break;
        if (projectIds.length === 0) continue;
        try {
          const fresh = await db
            .select()
            .from(alerts)
            .where(
              and(
                inArray(alerts.projectId, projectIds),
                gt(alerts.createdAt, lastSeen),
              ),
            )
            .orderBy(desc(alerts.createdAt))
            .limit(20);
          if (fresh.length > 0) {
            lastSeen = fresh[0].createdAt;
            for (const a of fresh.reverse()) {
              send("alert", serialiseAlert(a));
            }
          }
          // Heartbeat — keep proxies / iOS Safari from reaping the
          // stream after their idle timeout.
          send("ping", { ts: Date.now() });
        } catch (e) {
          send("error", { message: e instanceof Error ? e.message : String(e) });
          break;
        }
      }
      try {
        controller.close();
      } catch {
        // already closed (client disconnect) — ignore.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection:      "keep-alive",
    },
  });
}
