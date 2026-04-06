import { db, alerts } from "@/lib/db";
import { eq, sql } from "drizzle-orm";
import * as vercelApi from "@/lib/services/vercel-api";
import { logAudit } from "@/lib/audit";

const ROLLBACK_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

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

  // Cooldown: prevent repeated rollbacks within 10 minutes (any caller)
  try {
    const lockKey = `rollback:${vercelProjectId}`;
    const lockResult = await db.execute(
      sql`INSERT INTO cron_locks (key, expires_at)
          VALUES (${lockKey}, now() + interval '600 seconds')
          ON CONFLICT (key) DO UPDATE SET expires_at = now() + interval '600 seconds'
          WHERE cron_locks.expires_at < now()
          RETURNING key`
    );
    if (lockResult.rows.length === 0) {
      console.warn(`[auto-rollback] Cooldown active for ${projectName}. Skipping.`);
      return;
    }
  } catch {
    // cron_locks table may not exist (pre-migration) — proceed without cooldown
  }

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

    // Retry once on failure (transient Vercel API errors)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await vercelApi.rollbackToDeployment(
          token,
          teamId,
          lastGood.uid,
          projectName
        );
        break;
      } catch (err) {
        if (attempt === 0) {
          console.error("[auto-rollback] First attempt failed, retrying in 3s:", err instanceof Error ? err.message : err);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }

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
