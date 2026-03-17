import crypto from "crypto";
import { db, outgoingWebhooks, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import type { Alert } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

/**
 * Dispatch outgoing webhook calls for a newly created alert.
 * Sends HMAC-SHA256 signed POST requests to all active webhooks
 * whose events list includes the given event type.
 */
export async function dispatchOutgoingWebhooks(
  alert: Alert,
  event: "alert.created" | "alert.resolved" = "alert.created"
) {
  // Find the project owner
  const [project] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  if (!project) return;

  // Get all active webhooks for this user that listen to this event
  const webhooks = await db
    .select()
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.userId, project.userId));

  const activeWebhooks = webhooks.filter(
    (w) => w.isActive && w.events.includes(event)
  );

  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    alert: {
      id: alert.id,
      projectId: alert.projectId,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      sourceIntegrations: alert.sourceIntegrations,
      isResolved: alert.isResolved,
      createdAt: alert.createdAt.toISOString(),
    },
  });

  await Promise.allSettled(
    activeWebhooks.map(async (wh) => {
      const signature = crypto
        .createHmac("sha256", decrypt(wh.secret))
        .update(payload)
        .digest("hex");

      try {
        await fetch(wh.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Inari-Signature": `sha256=${signature}`,
            "X-Inari-Event": event,
          },
          body: payload,
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        // Fire-and-forget — webhook failures are non-blocking
      }
    })
  );
}
