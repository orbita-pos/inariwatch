import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as vercelApi from "@/lib/services/vercel-api";
import { logAudit } from "@/lib/audit";

/**
 * Automatically roll back a Vercel project to its last successful production
 * deployment. Called fire-and-forget from the webhook/cron poller when
 * `alertConfig.autoRollback` is enabled.
 *
 * Updates the alert body with the outcome (success or failure message)
 * and auto-resolves the alert on success.
 */
export async function triggerAutoRollback(opts: {
  alertId: string;
  token: string;
  teamId: string | undefined;
  vercelProjectId: string;
  projectName: string;
}): Promise<void> {
  const { alertId, token, teamId, vercelProjectId, projectName } = opts;

  try {
    const lastGood = await vercelApi.getLastSuccessfulDeploy(
      token,
      teamId,
      vercelProjectId
    );

    if (!lastGood) {
      const note =
        "\n\n⚡ Auto-rollback: no previous successful deployment found.";
      await db
        .update(alerts)
        .set({ body: sql`${alerts.body} || ${note}` })
        .where(eq(alerts.id, alertId));
      return;
    }

    await vercelApi.rollbackToDeployment(
      token,
      teamId,
      lastGood.uid,
      projectName
    );

    const shortId = lastGood.uid.slice(0, 8);
    const note = `\n\n✓ Auto-rolled back to ${shortId} — production restored automatically.`;
    await db
      .update(alerts)
      .set({ body: sql`${alerts.body} || ${note}`, isResolved: true })
      .where(eq(alerts.id, alertId));

    logAudit({
      userId: "system",
      action: "alert.auto_rollback",
      resource: "alert",
      resourceId: alertId,
      metadata: { deploymentId: lastGood.uid, url: lastGood.url, projectName },
    }).catch(() => {});
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const note = `\n\n✗ Auto-rollback failed: ${errMsg}`;
    await db
      .update(alerts)
      .set({ body: sql`${alerts.body} || ${note}` })
      .where(eq(alerts.id, alertId));
  }
}
