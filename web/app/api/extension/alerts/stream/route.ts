/**
 * GET /api/extension/alerts/stream — SSE stream of new alerts for extension
 *
 * Polls DB every 10s and sends new unread alerts as SSE events.
 * Auth: Bearer token (extension or mobile).
 */

import { NextRequest } from "next/server";
import { db, alerts, projects } from "@/lib/db";
import { eq, and, gt, inArray } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { authenticateExtension } from "@/lib/auth/extension";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await authenticateExtension(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return new Response(JSON.stringify({ error: "No projects" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const projectMap = Object.fromEntries(userProjects.map((p) => [p.id, p.name]));

  const encoder = new TextEncoder();
  let lastCheck = new Date();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));
    },
    async pull(controller) {
      try {
        const newAlerts = await db
          .select()
          .from(alerts)
          .where(
            and(
              inArray(alerts.projectId, projectIds),
              eq(alerts.isResolved, false),
              eq(alerts.isRead, false),
              gt(alerts.createdAt, lastCheck)
            )
          )
          .limit(5);

        lastCheck = new Date();

        if (newAlerts.length > 0) {
          for (const a of newAlerts) {
            const payload = {
              id: a.id,
              title: a.title,
              body: a.body,
              severity: a.severity,
              aiReasoning: a.aiReasoning ?? null,
              postmortem: a.postmortem ?? null,
              fingerprint: a.fingerprint ?? null,
              isRead: a.isRead,
              isResolved: a.isResolved,
              sourceIntegrations: a.sourceIntegrations,
              projectName: projectMap[a.projectId] ?? "?",
              createdAt: a.createdAt.toISOString(),
              source: "cloud" as const,
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }
        } else {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }

        // Wait 10 seconds before next poll
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      } catch {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
