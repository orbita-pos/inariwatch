import { db, alerts, projectIntegrations, apiKeys, notificationChannels, substrateRecordings } from "@/lib/db";
import { eq, and, desc, inArray, gt, sql } from "drizzle-orm";
import type { McpUser } from "../auth";
import { getUserProjectIds } from "../helpers";
import { TOOLS } from "../registry";

type CheckResult = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export async function execute(
  _args: Record<string, unknown>,
  user: McpUser
): Promise<string> {
  const projectIds = await getUserProjectIds(user.userId);
  if (projectIds.length === 0) return JSON.stringify({ status: "unhealthy", checks: [{ name: "Projects", status: "fail", detail: "No projects found" }], summary: "0 checks passed. Create a project first." });

  const checks: CheckResult[] = [];

  // Run all checks in parallel
  const results = await Promise.allSettled([
    checkCapture(projectIds),
    checkIntegrations(projectIds),
    checkPush(user.userId),
    checkAIKey(user.userId),
    checkCronPolling(projectIds),
    checkDB(),
    checkSubstrate(projectIds),
    checkMCP(),
  ]);

  const checkNames = ["Capture SDK", "Integrations", "Push Notifications", "AI Key", "Cron Polling", "Database", "Substrate", "MCP Tools"];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      checks.push(...result.value);
    } else {
      checks.push({
        name: checkNames[i],
        status: "fail",
        detail: `Check failed: ${result.reason instanceof Error ? result.reason.message : "unknown"}`,
      });
    }
  }

  const passCount = checks.filter((c) => c.status === "pass").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  const status = failCount > 0 ? "unhealthy" : warnCount > 0 ? "degraded" : "healthy";

  const problems = checks.filter((c) => c.status !== "pass").map((c) => c.name);
  const summary = failCount === 0 && warnCount === 0
    ? `${passCount}/${checks.length} checks passed. All systems operational.`
    : `${passCount}/${checks.length} checks passed. ${problems.join(", ")} need${problems.length === 1 ? "s" : ""} attention.`;

  return JSON.stringify({ status, checks, summary }, null, 2);
}

// ── Individual checks ────────────────────────────────────────────────────────

async function checkCapture(projectIds: string[]): Promise<CheckResult[]> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [recent] = await db
    .select({ count: sql<number>`count(*)` })
    .from(alerts)
    .where(and(
      inArray(alerts.projectId, projectIds),
      gt(alerts.createdAt, oneHourAgo),
      sql`'capture' = ANY(${alerts.sourceIntegrations})`
    ));

  const count = recent?.count ?? 0;

  if (count > 0) {
    return [{ name: "Capture SDK", status: "pass", detail: `${count} event(s) in last hour` }];
  }

  // Check if any capture alerts ever existed
  const [ever] = await db
    .select({ count: sql<number>`count(*)` })
    .from(alerts)
    .where(and(
      inArray(alerts.projectId, projectIds),
      sql`'capture' = ANY(${alerts.sourceIntegrations})`
    ));

  if ((ever?.count ?? 0) > 0) {
    return [{ name: "Capture SDK", status: "warn", detail: "No events in last hour (previously active)" }];
  }

  return [{ name: "Capture SDK", status: "warn", detail: "No capture events found. Install: npx @inariwatch/capture" }];
}

async function checkIntegrations(projectIds: string[]): Promise<CheckResult[]> {
  const integs = await db
    .select()
    .from(projectIntegrations)
    .where(and(
      inArray(projectIntegrations.projectId, projectIds),
      eq(projectIntegrations.isActive, true)
    ));

  if (integs.length === 0) {
    return [{ name: "Integrations", status: "warn", detail: "No integrations connected" }];
  }

  const results: CheckResult[] = [];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  for (const integ of integs) {
    const name = `${integ.service.charAt(0).toUpperCase() + integ.service.slice(1)} integration`;
    const issues: string[] = [];

    if ((integ.errorCount ?? 0) > 0) issues.push(`errorCount: ${integ.errorCount}`);
    if (!integ.webhookSecret) issues.push("no webhook configured");
    if (integ.lastSuccessAt && integ.lastSuccessAt < oneHourAgo) {
      issues.push(`last success: ${timeAgo(integ.lastSuccessAt)}`);
    }

    if (issues.length === 0) {
      const lastPoll = integ.lastCheckedAt ? `last poll ${timeAgo(integ.lastCheckedAt)}` : "active";
      results.push({ name, status: "pass", detail: `Token configured, ${lastPoll}` });
    } else if ((integ.errorCount ?? 0) > 5) {
      results.push({ name, status: "fail", detail: issues.join(", ") });
    } else {
      results.push({ name, status: "warn", detail: issues.join(", ") });
    }
  }

  return results;
}

async function checkPush(userId: string): Promise<CheckResult[]> {
  const channels = await db
    .select({ id: notificationChannels.id, type: notificationChannels.type })
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.isActive, true)));

  if (channels.length === 0) {
    return [{ name: "Notifications", status: "warn", detail: "No notification channels configured" }];
  }

  const types = channels.map((c) => c.type).filter(Boolean);
  return [{ name: "Notifications", status: "pass", detail: `${channels.length} channel(s): ${types.join(", ")}` }];
}

async function checkAIKey(userId: string): Promise<CheckResult[]> {
  const AI_SERVICES = ["claude", "openai", "grok", "deepseek", "gemini"];
  const keys = await db
    .select({ service: apiKeys.service })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));

  const aiKey = keys.find((k) => AI_SERVICES.includes(k.service));

  if (!aiKey) {
    return [{ name: "AI Key", status: "warn", detail: "No AI key configured. Add one in Settings for root cause analysis." }];
  }

  return [{ name: "AI Key", status: "pass", detail: `${aiKey.service} key configured` }];
}

async function checkCronPolling(projectIds: string[]): Promise<CheckResult[]> {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);

  const [recent] = await db
    .select({ count: sql<number>`count(*)` })
    .from(projectIntegrations)
    .where(and(
      inArray(projectIntegrations.projectId, projectIds),
      eq(projectIntegrations.isActive, true),
      gt(projectIntegrations.lastCheckedAt, tenMinAgo)
    ));

  const count = recent?.count ?? 0;

  if (count > 0) {
    return [{ name: "Cron Polling", status: "pass", detail: `${count} integration(s) polled in last 10 min` }];
  }

  return [{ name: "Cron Polling", status: "warn", detail: "No polling activity in last 10 min" }];
}

async function checkDB(): Promise<CheckResult[]> {
  const start = Date.now();
  await db.execute(sql`SELECT 1 as ok`);
  const ms = Date.now() - start;

  if (ms > 2000) {
    return [{ name: "Database", status: "warn", detail: `Responding but slow (${ms}ms)` }];
  }

  return [{ name: "Database", status: "pass", detail: `OK (${ms}ms)` }];
}

async function checkSubstrate(projectIds: string[]): Promise<CheckResult[]> {
  const [count] = await db
    .select({ count: sql<number>`count(*)` })
    .from(substrateRecordings)
    .where(sql`${substrateRecordings.alertId} IN (SELECT id FROM alerts WHERE project_id = ANY(${projectIds}))`);

  if ((count?.count ?? 0) > 0) {
    return [{ name: "Substrate", status: "pass", detail: `${count?.count} recording(s) found` }];
  }

  return [{ name: "Substrate", status: "warn", detail: "No recordings. Enable with INARIWATCH_SUBSTRATE=true" }];
}

async function checkMCP(): Promise<CheckResult[]> {
  return [{ name: "MCP Tools", status: "pass", detail: `${TOOLS.length} tools available` }];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
