import { NextResponse } from "next/server";
import { db, projectIntegrations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { pollGitHub, type GithubAlertConfig } from "@/lib/pollers/github";
import { pollVercel, type VercelAlertConfig } from "@/lib/pollers/vercel-api";
import { pollSentry, type SentryAlertConfig } from "@/lib/pollers/sentry";
import { pollUptime, type UptimeEndpoint, type UptimeAlertConfig } from "@/lib/pollers/uptime";
import { pollPostgres, type PostgresConfig, type PostgresAlertConfig } from "@/lib/pollers/postgres";
import { pollNpmAudit, type NpmAuditConfig, type NpmAuditAlertConfig } from "@/lib/pollers/npm-audit";
import { processNotificationQueue, processEmailDigests } from "@/lib/notifications/send";
import { createAlertIfNew, markIntegrationSuccess } from "@/lib/webhooks/shared";
import { correlateProjectAlerts } from "@/lib/ai/correlate";
import { runAnomalyEngine } from "@/lib/pollers/anomaly";
import { decryptConfig } from "@/lib/crypto";
import type { NewAlert, Alert } from "@/lib/db";

import crypto from "crypto";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: Request) {
  // Verify secret — fail closed (reject if secret is unset)
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integrations = await db
    .select({
      id:              projectIntegrations.id,
      projectId:       projectIntegrations.projectId,
      service:         projectIntegrations.service,
      configEncrypted: projectIntegrations.configEncrypted,
      errorCount:      projectIntegrations.errorCount,
    })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.isActive, true));

  let created = 0;
  const errors: string[] = [];
  // Track new alerts per project for AI correlation
  const newAlertsByProject = new Map<string, Alert[]>();

  // Poll all integrations in parallel — eliminates sequential waterfall
  async function pollIntegration(integ: typeof integrations[number]) {
    const cfg = decryptConfig(integ.configEncrypted);
    const token = cfg.token as string | undefined;
    if (!token && !["uptime", "postgres", "npm"].includes(integ.service)) return [];

    const alertConfig = (cfg.alertConfig ?? {}) as Record<string, unknown>;
    let newAlerts: Omit<NewAlert, "projectId">[] = [];

    if (integ.service === "github") {
      const owner = (cfg.owner as string) ?? "";
      newAlerts = await pollGitHub(token!, owner, alertConfig as GithubAlertConfig);
    } else if (integ.service === "vercel") {
      const teamId = (cfg.teamId as string) ?? "";
      newAlerts = await pollVercel(token!, teamId, alertConfig as VercelAlertConfig);
    } else if (integ.service === "sentry") {
      const org = (cfg.org as string) ?? "";
      newAlerts = await pollSentry(token!, org, alertConfig as SentryAlertConfig);
    } else if (integ.service === "uptime") {
      const endpoints = (cfg.endpoints ?? []) as UptimeEndpoint[];
      if (endpoints.length > 0) {
        newAlerts = await pollUptime(endpoints, alertConfig as UptimeAlertConfig);
      }
    } else if (integ.service === "postgres") {
      const connString = cfg.connectionString as string | undefined;
      if (connString) {
        newAlerts = await pollPostgres(
          { connectionString: connString, name: (cfg.name as string) || "PostgreSQL" } as PostgresConfig,
          alertConfig as PostgresAlertConfig
        );
      }
    } else if (integ.service === "npm") {
      newAlerts = await pollNpmAudit(
        {
          packageJsonUrl: cfg.packageJsonUrl as string | undefined,
          cargoTomlUrl: cfg.cargoTomlUrl as string | undefined,
          token: token,
        } as NpmAuditConfig,
        alertConfig as NpmAuditAlertConfig
      );
    }

    await markIntegrationSuccess(integ.id);
    return newAlerts.map((a) => ({ ...a, projectId: integ.projectId }));
  }

  const results = await Promise.allSettled(integrations.map((integ) => pollIntegration(integ)));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const integ = integrations[i];
    if (result.status === "fulfilled") {
      for (const { projectId, ...alert } of result.value) {
        const inserted = await createAlertIfNew(alert, projectId);
        if (inserted) {
          created++;
          const group = newAlertsByProject.get(projectId) ?? [];
          group.push(inserted);
          newAlertsByProject.set(projectId, group);
        }
      }
    } else {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${integ.service}/${integ.id}: ${errMsg}`);
      db.update(projectIntegrations)
        .set({ lastCheckedAt: new Date(), errorCount: (integ.errorCount ?? 0) + 1 })
        .where(eq(projectIntegrations.id, integ.id))
        .catch(() => {});
    }
  }

  // Run AI correlation for projects with 2+ new alerts
  for (const [projectId, projectAlerts] of newAlertsByProject.entries()) {
    correlateProjectAlerts(projectAlerts, projectId).catch(() => {});
  }

  // Run anomaly detection across all active projects
  const allProjectIds = [...new Set(integrations.map((i) => i.projectId))];
  try {
    const anomalies = await runAnomalyEngine(allProjectIds);
    for (const anomaly of anomalies) {
      const { projectId, ...alert } = anomaly;
      const result = await createAlertIfNew(alert, projectId);
      if (result) created++;
    }
  } catch {
    // Anomaly detection failure should not break the cron response
  }

  // Process notification queue in one batch after all alerts are created
  // 1. Immediate: critical emails + all push/telegram/slack
  // 2. Digest: batched non-critical emails → one email per user
  let notifyResult = { sent: 0, failed: 0, skipped: 0 };
  let digestResult = { sent: 0, failed: 0 };
  try {
    notifyResult = await processNotificationQueue();
  } catch {
    // Queue processing failure should not break the cron response
  }
  try {
    digestResult = await processEmailDigests();
  } catch {
    // Digest processing failure should not break the cron response
  }

  return NextResponse.json({
    ok: true,
    created,
    notifications: notifyResult,
    digests: digestResult,
    errors,
  });
}
