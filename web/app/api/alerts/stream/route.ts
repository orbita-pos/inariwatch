import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, alerts, getUserProjectIds } from "@/lib/db";
import { desc, inArray } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const projectIds = await getUserProjectIds(userId);

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial connection event
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

      // Poll every 10 seconds for new alerts
      let lastCheckTime = new Date();

      const interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval);
          return;
        }

        try {
          if (projectIds.length === 0) return;

          const newAlerts = await db
            .select({
              id: alerts.id,
              severity: alerts.severity,
              title: alerts.title,
              createdAt: alerts.createdAt,
              isRead: alerts.isRead,
              isResolved: alerts.isResolved,
            })
            .from(alerts)
            .where(inArray(alerts.projectId, projectIds))
            .orderBy(desc(alerts.createdAt))
            .limit(5);

          const recent = newAlerts.filter(
            (a) => a.createdAt > lastCheckTime
          );

          if (recent.length > 0) {
            lastCheckTime = new Date();
            const data = JSON.stringify({
              alerts: recent,
              unreadCount: newAlerts.filter((a) => !a.isRead).length,
            });
            controller.enqueue(
              encoder.encode(`event: alerts\ndata: ${data}\n\n`)
            );
          }

          // Heartbeat
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Ignore errors in the polling loop
        }
      }, 10000);

      // Cleanup on close
      const checkClosed = setInterval(() => {
        if (closed) {
          clearInterval(interval);
          clearInterval(checkClosed);
          try { controller.close(); } catch {}
        }
      }, 1000);
    },
    cancel() {
      closed = true;
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
