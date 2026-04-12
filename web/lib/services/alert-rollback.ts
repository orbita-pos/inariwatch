/**
 * Shared alert-rollback service — single source of truth for "roll back an
 * alert's deploy". Used by:
 *  - Dashboard: /alerts/[id] Rollback button (rollback-actions.ts)
 *  - Slack: /inariwatch rollback <project> command
 *  - MCP: rollback_deploy tool (with rollback_vercel alias for back-compat)
 *
 * Dispatches to whichever hosting provider the project has connected via
 * `findHostingProvider`, so the same code path works for Vercel, Netlify,
 * Cloudflare Pages, and Render.
 */

import { db, alerts, projects, type Alert } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { findHostingProvider } from "@/lib/services/auto-rollback";
import { getRollbackProvider, UnsupportedProviderError } from "@/lib/providers/rollback";
import type { HostingService } from "@/lib/providers/rollback";
import { logAudit } from "@/lib/audit";

export interface RollbackAlertResult {
  /** Deployment URL that is now live (if rollback succeeded). */
  url?: string;
  /** Deployment ID that was promoted. */
  deploymentId?: string;
  /** Which hosting provider was used. */
  provider?: HostingService;
  /** Error message (if any step failed). */
  error?: string;
}

export interface RollbackAlertOptions {
  alertId: string;
  /** If provided, verifies the user owns the alert's project before rolling back. */
  userId?: string;
  /**
   * If true (default), the service updates the alert to isResolved=true on success.
   * Set to false for dry-run-like contexts (e.g., MCP preview mode).
   */
  resolveOnSuccess?: boolean;
  /** Label for the audit log — "dashboard" | "slack" | "mcp" | "cron". */
  source?: string;
}

export interface RollbackProjectOptions {
  projectId: string;
  /** If provided, verifies the user owns the project before rolling back. */
  userId?: string;
  /** Label for the audit log. */
  source?: string;
}

/**
 * Roll back a project's current production deployment to the last successful
 * one. Host-agnostic — uses `findHostingProvider`. Used by:
 *  - Slack `/inariwatch rollback <project>` command
 *  - MCP `rollback_deploy` tool (no alert context)
 *  - Any caller that has a projectId but no alertId
 */
export async function rollbackProjectDeploy(
  options: RollbackProjectOptions,
): Promise<RollbackAlertResult> {
  const { projectId, userId, source = "unknown" } = options;

  // Ownership check (optional). We deliberately return the same generic
  // "not found" message as a missing project so callers can't distinguish
  // "exists but not yours" from "doesn't exist" — no resource enumeration.
  if (userId) {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) return { error: "Project not found." };
  }

  const providerConfig = await findHostingProvider(projectId);
  if (!providerConfig) {
    return {
      error:
        "No hosting integration connected for this project. Connect Vercel, Netlify, Cloudflare Pages, or Render first.",
    };
  }

  try {
    const provider = getRollbackProvider(providerConfig);
    const lastGood = await provider.getLastSuccessfulDeploy();
    if (!lastGood) {
      return {
        error: `No previous successful deployment found on ${providerConfig.service}. Cannot rollback.`,
      };
    }

    const result = await provider.rollbackToDeployment(lastGood.id);

    logAudit({
      userId: userId ?? "system",
      action: "project.rollback",
      resource: "project",
      resourceId: projectId,
      metadata: {
        source,
        provider: providerConfig.service,
        deploymentId: result.deploymentId,
        url: result.url,
      },
    }).catch(() => {});

    return {
      url: result.url || lastGood.url,
      deploymentId: result.deploymentId,
      provider: providerConfig.service,
    };
  } catch (err) {
    if (err instanceof UnsupportedProviderError) {
      return {
        error: `Rollback for ${providerConfig.service} is not yet implemented.`,
      };
    }
    const msg = err instanceof Error ? err.message : "Rollback failed";
    return { error: msg };
  }
}

/**
 * Roll back the deployment associated with an alert's project to the last
 * successful production deploy. Host-agnostic: uses `findHostingProvider` to
 * pick whichever hosting integration the project has connected, in priority
 * order (vercel > netlify > cloudflare-pages > render).
 */
export async function rollbackAlertDeploy(
  options: RollbackAlertOptions,
): Promise<RollbackAlertResult> {
  const { alertId, userId, resolveOnSuccess = true, source = "unknown" } = options;

  // ── Fetch alert ───────────────────────────────────────────────────────────
  const [alert]: Alert[] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);
  if (!alert) return { error: "Alert not found." };

  // ── Ownership check (optional) ────────────────────────────────────────────
  // Same generic message as "alert not found" to avoid exposing whether a
  // given alert ID exists across other workspaces.
  if (userId) {
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, alert.projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) return { error: "Alert not found." };
  }

  // ── Pick hosting provider ─────────────────────────────────────────────────
  const providerConfig = await findHostingProvider(alert.projectId);
  if (!providerConfig) {
    return {
      error:
        "No hosting integration connected for this project. Connect Vercel, Netlify, Cloudflare Pages, or Render first.",
    };
  }

  // ── Execute the rollback ──────────────────────────────────────────────────
  try {
    const provider = getRollbackProvider(providerConfig);
    const lastGood = await provider.getLastSuccessfulDeploy();
    if (!lastGood) {
      return {
        error: `No previous successful deployment found on ${providerConfig.service}. Cannot rollback.`,
      };
    }

    const result = await provider.rollbackToDeployment(lastGood.id);

    // Auto-resolve the alert if requested
    if (resolveOnSuccess) {
      await db
        .update(alerts)
        .set({ isResolved: true, isRead: true })
        .where(eq(alerts.id, alertId));
    }

    // Audit
    logAudit({
      userId: userId ?? "system",
      action: "alert.rollback",
      resource: "alert",
      resourceId: alertId,
      metadata: {
        source,
        provider: providerConfig.service,
        deploymentId: result.deploymentId,
        url: result.url,
      },
    }).catch(() => {});

    return {
      url: result.url || lastGood.url,
      deploymentId: result.deploymentId,
      provider: providerConfig.service,
    };
  } catch (err) {
    if (err instanceof UnsupportedProviderError) {
      return {
        error: `Rollback for ${providerConfig.service} is not yet implemented. Use the ${providerConfig.service} dashboard manually.`,
      };
    }
    const msg = err instanceof Error ? err.message : "Rollback failed";
    return { error: msg };
  }
}
