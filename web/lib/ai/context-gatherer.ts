/**
 * Multi-integration context gathering for AI remediation.
 *
 * Before diagnosing an error, gathers ALL available context from connected
 * integrations: Sentry stack traces, Vercel build logs, GitHub CI logs,
 * Datadog monitor data. The more context the AI has, the more accurate the fix.
 */

import { db, projectIntegrations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { decryptConfig } from "@/lib/crypto";
import type { RemediationContext } from "./prompts";
import * as gh from "@/lib/services/github-api";
import { getDeploymentBuildLogs, getLatestFailedDeployment } from "@/lib/services/vercel-api";

type AlertInfo = {
  title: string;
  body: string;
  sourceIntegrations: string[];
};

type Emit = (event: string, data: unknown) => void;

// ── Sentry ──────────────────────────────────────────────────────────────────

async function fetchSentryContext(
  token: string,
  org: string,
  alert: AlertInfo
): Promise<{ stackTrace: string | null; issueDetails: string | null }> {
  // Try to extract issue ID from alert body
  const idMatch = alert.body.match(/ID:\s*([A-Z0-9-]+)/i) ?? alert.body.match(/issues\/(\d+)/);
  let issueId = idMatch?.[1] ?? null;

  // If no explicit ID, search for the issue by title
  if (!issueId) {
    try {
      const titleQuery = encodeURIComponent(alert.title.replace(/\[.*?\]\s*/, "").slice(0, 80));
      const searchRes = await fetch(
        `https://sentry.io/api/0/organizations/${org}/issues/?query=${titleQuery}&limit=1`,
        { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 } }
      );
      if (searchRes.ok) {
        const issues = await searchRes.json();
        if (issues.length > 0) issueId = issues[0].id;
      }
    } catch { /* skip search failures */ }
  }

  if (!issueId) return { stackTrace: null, issueDetails: null };

  // Fetch latest event with stack trace
  let stackTrace: string | null = null;
  let issueDetails: string | null = null;

  try {
    const eventRes = await fetch(
      `https://sentry.io/api/0/issues/${issueId}/events/latest/`,
      { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 } }
    );
    if (eventRes.ok) {
      const event = await eventRes.json();
      const entries = event.entries as { type: string; data: Record<string, unknown> }[] | undefined;
      if (entries) {
        const exceptionEntry = entries.find((e) => e.type === "exception");
        if (exceptionEntry) {
          const values = (exceptionEntry.data.values ?? []) as {
            type?: string; value?: string;
            stacktrace?: { frames?: { filename?: string; lineNo?: number; function?: string }[] };
          }[];
          const parts: string[] = [];
          for (const exc of values) {
            if (exc.type || exc.value) parts.push(`${exc.type ?? "Error"}: ${exc.value ?? ""}`);
            const frames = exc.stacktrace?.frames;
            if (frames) {
              for (const f of frames.slice(-10)) {
                const loc = f.lineNo ? `:${f.lineNo}` : "";
                parts.push(`  at ${f.function ?? "<anonymous>"} (${f.filename ?? "unknown"}${loc})`);
              }
            }
          }
          if (parts.length > 0) stackTrace = parts.join("\n");
        }

        // Breadcrumbs for additional context
        const breadcrumbEntry = entries.find((e) => e.type === "breadcrumbs");
        if (breadcrumbEntry) {
          const crumbs = (breadcrumbEntry.data.values ?? []) as { category?: string; message?: string; level?: string }[];
          const recentCrumbs = crumbs.slice(-5).map((c) => `[${c.category}] ${c.message ?? ""}`).join("\n");
          if (recentCrumbs) {
            issueDetails = `Recent breadcrumbs:\n${recentCrumbs}`;
          }
        }
      }

      // Add tags and context
      const tags = event.tags as { key: string; value: string }[] | undefined;
      if (tags) {
        const relevant = tags.filter((t) =>
          ["environment", "release", "browser", "os", "runtime"].includes(t.key)
        );
        if (relevant.length > 0) {
          issueDetails = (issueDetails ?? "") + `\nTags: ${relevant.map((t) => `${t.key}=${t.value}`).join(", ")}`;
        }
      }
    }
  } catch { /* skip event fetch failures */ }

  return { stackTrace, issueDetails };
}

// ── Vercel ──────────────────────────────────────────────────────────────────

async function fetchVercelContext(
  token: string,
  teamId: string | undefined,
  alert: AlertInfo,
  projectName: string
): Promise<string | null> {
  const depMatch = alert.body.match(/deployment:([a-zA-Z0-9_-]+)/);
  let deploymentId = depMatch ? depMatch[1] : null;

  if (!deploymentId) {
    deploymentId = await getLatestFailedDeployment(token, teamId, projectName);
  }

  if (!deploymentId) return null;
  return getDeploymentBuildLogs(token, teamId, deploymentId);
}

// ── GitHub CI ───────────────────────────────────────────────────────────────

async function fetchGitHubCIContext(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string | null> {
  try {
    return await gh.getFailedCheckLogs(token, owner, repo, branch);
  } catch {
    return null;
  }
}

// ── Datadog ─────────────────────────────────────────────────────────────────

async function fetchDatadogContext(
  apiKey: string,
  appKey: string,
  alert: AlertInfo
): Promise<string | null> {
  // Extract monitor ID from alert body
  const monitorMatch = alert.body.match(/Monitor ID:\s*(\d+)/i);
  if (!monitorMatch) return null;

  try {
    const res = await fetch(
      `https://api.datadoghq.com/api/v1/monitor/${monitorMatch[1]}`,
      {
        headers: {
          "DD-API-KEY": apiKey,
          "DD-APPLICATION-KEY": appKey,
        },
        next: { revalidate: 0 },
      }
    );
    if (!res.ok) return null;
    const monitor = await res.json();
    return [
      `Monitor: ${monitor.name ?? "unknown"}`,
      `Type: ${monitor.type ?? "unknown"}`,
      `Query: ${(monitor.query as string)?.slice(0, 200) ?? ""}`,
      `Message: ${(monitor.message as string)?.slice(0, 300) ?? ""}`,
      `Status: ${monitor.overall_state ?? "unknown"}`,
    ].join("\n");
  } catch {
    return null;
  }
}

// ── Master orchestrator ──────────────────────────────────────────────────────

export async function gatherRemediationContext(
  projectId: string,
  alert: AlertInfo,
  projectName: string,
  emit: Emit
): Promise<RemediationContext> {
  const result: RemediationContext = {
    sentryStackTrace: null,
    sentryIssueDetails: null,
    vercelBuildLogs: null,
    githubCILogs: null,
    datadogMetrics: null,
  };

  const integrations = await db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, projectId));

  const tasks: Promise<void>[] = [];

  // Sentry
  const sentryInteg = integrations.find((i) => i.service === "sentry");
  if (sentryInteg) {
    tasks.push((async () => {
      emit("context", { source: "sentry", status: "fetching" });
      const config = decryptConfig(sentryInteg.configEncrypted);
      const token = config.token as string;
      const org = config.org as string;
      if (token && org) {
        const ctx = await fetchSentryContext(token, org, alert);
        result.sentryStackTrace = ctx.stackTrace;
        result.sentryIssueDetails = ctx.issueDetails;
        emit("context", { source: "sentry", status: ctx.stackTrace ? "found" : "empty" });
      }
    })());
  }

  // Vercel
  const vercelInteg = integrations.find((i) => i.service === "vercel");
  if (vercelInteg && alert.sourceIntegrations.includes("vercel")) {
    tasks.push((async () => {
      emit("context", { source: "vercel", status: "fetching" });
      const config = decryptConfig(vercelInteg.configEncrypted);
      const token = config.token as string;
      const teamId = (config.teamId as string) || undefined;
      if (token) {
        result.vercelBuildLogs = await fetchVercelContext(token, teamId, alert, projectName);
        emit("context", { source: "vercel", status: result.vercelBuildLogs ? "found" : "empty" });
      }
    })());
  }

  // GitHub CI logs
  const ghInteg = integrations.find((i) => i.service === "github");
  if (ghInteg && alert.sourceIntegrations.includes("github")) {
    tasks.push((async () => {
      emit("context", { source: "github", status: "fetching" });
      const config = decryptConfig(ghInteg.configEncrypted);
      const token = config.token as string;
      const owner = config.owner as string;
      // Try to extract repo from alert title
      const repoMatch = alert.title.match(/\bon\s+([a-zA-Z0-9_.-]+)\//) ?? alert.title.match(/—\s+([a-zA-Z0-9_.-]+)/);
      const repo = repoMatch?.[1];
      if (token && owner && repo) {
        const branch = "main"; // will be refined in the remediate engine
        result.githubCILogs = await fetchGitHubCIContext(token, owner, repo, branch);
        emit("context", { source: "github", status: result.githubCILogs ? "found" : "empty" });
      }
    })());
  }

  // Datadog
  const ddInteg = integrations.find((i) => i.service === "datadog");
  if (ddInteg && alert.sourceIntegrations.includes("datadog")) {
    tasks.push((async () => {
      emit("context", { source: "datadog", status: "fetching" });
      const config = decryptConfig(ddInteg.configEncrypted);
      const apiKey = config.apiKey as string;
      const appKey = config.appKey as string;
      if (apiKey && appKey) {
        result.datadogMetrics = await fetchDatadogContext(apiKey, appKey, alert);
        emit("context", { source: "datadog", status: result.datadogMetrics ? "found" : "empty" });
      }
    })());
  }

  // Run all in parallel
  await Promise.allSettled(tasks);

  return result;
}
