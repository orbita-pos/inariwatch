import { db, alerts, projectIntegrations } from "@/lib/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getRollbackProvider, UnsupportedProviderError } from "@/lib/providers/rollback";
import type { HostingService, ProviderConfig } from "@/lib/providers/rollback";
import { decryptConfig } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";

const ROLLBACK_COOLDOWN_SECONDS = 600; // 10 minutes
void ROLLBACK_COOLDOWN_SECONDS;

/**
 * Priority order for auto-heal when a project has multiple hosting integrations
 * connected. Vercel is preferred first for historical reasons (the feature was
 * built against it), then the hosts in order of implementation maturity.
 * Railway and Fly are excluded because their providers are stubs.
 */
const HOSTING_PRIORITY: HostingService[] = [
  "vercel",
  "netlify",
  "cloudflare-pages",
  "render",
];

/**
 * Find the first available hosting-provider integration for a project and
 * build a `ProviderConfig` from its decrypted config.
 *
 * Used by auto-heal (uptime down → rollback) to dispatch to whichever host
 * the user has connected, rather than assuming Vercel. Returns null when no
 * hosting integration is configured or the matching integration is inactive.
 */
export async function findHostingProvider(projectId: string): Promise<ProviderConfig | null> {
  const rows = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.projectId, projectId),
        eq(projectIntegrations.isActive, true),
        inArray(projectIntegrations.service, HOSTING_PRIORITY),
      ),
    );

  if (rows.length === 0) return null;

  // Sort by priority — rows come back in arbitrary order from the DB.
  rows.sort((a, b) => {
    const ai = HOSTING_PRIORITY.indexOf(a.service as HostingService);
    const bi = HOSTING_PRIORITY.indexOf(b.service as HostingService);
    return ai - bi;
  });

  for (const row of rows) {
    const cfg = decryptConfig(row.configEncrypted);
    const token = cfg.token as string | undefined;
    if (!token) continue;

    switch (row.service as HostingService) {
      case "vercel":
        return {
          service: "vercel",
          token,
          teamId: cfg.teamId as string | undefined,
          projectName: (cfg.projectId as string) ?? (cfg.projectName as string) ?? "",
        };
      case "netlify": {
        const siteId = cfg.siteId as string | undefined;
        if (!siteId) continue;
        return {
          service: "netlify",
          token,
          siteId,
          projectName: (cfg.projectName as string) ?? siteId,
        };
      }
      case "cloudflare-pages": {
        const accountId = cfg.accountId as string | undefined;
        const projectName = cfg.projectName as string | undefined;
        if (!accountId || !projectName) continue;
        return { service: "cloudflare-pages", token, accountId, projectName };
      }
      case "render": {
        const serviceId = cfg.serviceId as string | undefined;
        const projectName = cfg.projectName as string | undefined;
        if (!serviceId || !projectName) continue;
        return { service: "render", token, serviceId, projectName };
      }
      default:
        continue;
    }
  }

  return null;
}

/**
 * Automatically roll back a deployment on any supported hosting provider
 * (Vercel, Netlify, Cloudflare Pages, Render — Railway and Fly are stubs).
 * Called fire-and-forget from webhooks or cron pollers when
 * `alertConfig.autoRollback` is enabled.
 *
 * Updates the alert body with the outcome (success or failure message)
 * and auto-resolves the alert on success.
 */
export async function triggerProviderRollback(opts: {
  alertId: string;
  providerConfig: ProviderConfig;
  /**
   * Internal database project ID. Required so the cooldown lock is keyed by
   * a tenant-unique identifier rather than the user-provided projectName,
   * which can collide across users (two distinct users with a project both
   * named "my-app" would share a lock and starve each other's auto-heal).
   * Falls back to `service:projectName` only if not provided, for tests.
   */
  projectId?: string;
}): Promise<void> {
  const { alertId, providerConfig, projectId } = opts;
  const { service, projectName } = providerConfig;

  // Cooldown: prevent repeated rollbacks within 10 minutes per project+service.
  // Keyed by (service, projectId) so different tenants can never collide on
  // the same lock — projectName is user-controlled and not unique.
  try {
    const lockSuffix = projectId ?? projectName;
    const lockKey = `rollback:${service}:${lockSuffix}`;
    const lockResult = await db.execute(
      sql`INSERT INTO cron_locks (key, expires_at)
          VALUES (${lockKey}, now() + interval '600 seconds')
          ON CONFLICT (key) DO UPDATE SET expires_at = now() + interval '600 seconds'
          WHERE cron_locks.expires_at < now()
          RETURNING key`,
    );
    if (lockResult.rows.length === 0) {
      console.warn(`[auto-rollback] Cooldown active for ${service}:${lockSuffix}. Skipping.`);
      return;
    }
  } catch {
    // cron_locks table may not exist in tests / pre-migration — proceed without cooldown.
  }

  try {
    const provider = getRollbackProvider(providerConfig);
    const lastGood = await provider.getLastSuccessfulDeploy();

    if (!lastGood) {
      const note = `\n\n⚡ Auto-rollback (${service}): no previous successful deployment found.`;
      await db
        .update(alerts)
        .set({ body: sql`${alerts.body} || ${note}` })
        .where(eq(alerts.id, alertId));
      return;
    }

    // Retry once on failure (transient API errors)
    let rollbackResult: { url: string; deploymentId: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rollbackResult = await provider.rollbackToDeployment(lastGood.id);
        break;
      } catch (err) {
        if (attempt === 0) {
          console.error(
            `[auto-rollback] First attempt failed for ${service}, retrying in 3s:`,
            err instanceof Error ? err.message : err,
          );
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }

    if (!rollbackResult) return;

    const shortId = rollbackResult.deploymentId.slice(0, 8);
    const note = `\n\n✓ Auto-rolled back to ${shortId} on ${service} — production restored automatically.`;
    await db
      .update(alerts)
      .set({ body: sql`${alerts.body} || ${note}`, isResolved: true })
      .where(eq(alerts.id, alertId));

    logAudit({
      userId: "system",
      action: "alert.auto_rollback",
      resource: "alert",
      resourceId: alertId,
      metadata: {
        service,
        deploymentId: rollbackResult.deploymentId,
        url: rollbackResult.url,
        projectName,
      },
    }).catch(() => {});
  } catch (err) {
    const isUnsupported = err instanceof UnsupportedProviderError;
    const errMsg = err instanceof Error ? err.message : String(err);
    const note = isUnsupported
      ? `\n\n⚡ Auto-rollback skipped: ${service} is not yet supported.`
      : `\n\n✗ Auto-rollback (${service}) failed: ${errMsg}`;
    await db
      .update(alerts)
      .set({ body: sql`${alerts.body} || ${note}` })
      .where(eq(alerts.id, alertId));
  }
}

/**
 * Legacy Vercel-shaped entrypoint. Preserved so existing callers (webhooks,
 * cron pollers, chaos tests) keep working without churn. New code should use
 * `triggerProviderRollback` directly.
 *
 * `projectId` is optional for backward compatibility but strongly preferred:
 * it's used as the cooldown lock key so different tenants can't collide on
 * a shared `projectName`.
 */
export async function triggerAutoRollback(opts: {
  alertId: string;
  token: string;
  teamId: string | undefined;
  vercelProjectId: string;
  projectName: string;
  projectId?: string;
}): Promise<void> {
  return triggerProviderRollback({
    alertId: opts.alertId,
    projectId: opts.projectId,
    providerConfig: {
      service: "vercel",
      token: opts.token,
      teamId: opts.teamId,
      // Vercel API accepts either projectId or projectName here — we pass the
      // ID the caller gave us as the "projectName" field because that's what
      // vercel-api.ts historically used as the lookup key.
      projectName: opts.vercelProjectId || opts.projectName,
    },
  });
}
