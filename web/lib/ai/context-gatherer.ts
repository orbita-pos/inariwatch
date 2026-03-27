/**
 * Multi-integration context gathering for AI remediation.
 *
 * Before diagnosing an error, gathers ALL available context from connected
 * integrations: Sentry stack traces, Vercel build logs, GitHub CI logs,
 * Datadog monitor data. The more context the AI has, the more accurate the fix.
 */

import { db, projectIntegrations, substrateRecordings } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
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
    substrateContext: null,
    eapReceipt: null,
    deployContext: null,
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

  // Deploy context — files changed in last commit (likely cause of the error)
  if (ghInteg) {
    tasks.push((async () => {
      try {
        const config = decryptConfig(ghInteg.configEncrypted);
        const token = config.token as string;
        const owner = config.owner as string;
        const repo = (config.repo ?? (config.repos as string[] | undefined)?.[0] ?? "") as string;
        if (token && owner && repo) {
          const commit = await gh.getRecentCommitFiles(token, owner, repo, "main");
          if (commit && commit.files.length > 0) {
            const fileList = commit.files
              .map((f) => `  ${f.filename} (${f.status} +${f.additions} -${f.deletions})`)
              .join("\n");
            result.deployContext = `Last deploy: ${commit.sha.slice(0, 8)} "${commit.message.split("\n")[0]}"\nFiles changed:\n${fileList}`;
          }
        }
      } catch { /* non-blocking */ }
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

  // Substrate recording (check if there's a recording linked to this project)
  tasks.push((async () => {
    emit("context", { source: "substrate", status: "fetching" });
    try {
      const recordings = await db
        .select({ context: substrateRecordings.context })
        .from(substrateRecordings)
        .where(eq(substrateRecordings.projectId, projectId))
        .orderBy(desc(substrateRecordings.createdAt))
        .limit(1);

      if (recordings.length > 0 && recordings[0].context) {
        result.substrateContext = recordings[0].context;
        emit("context", { source: "substrate", status: "found" });
      } else {
        emit("context", { source: "substrate", status: "empty" });
      }
    } catch {
      emit("context", { source: "substrate", status: "empty" });
    }
  })());

  // EAP receipt (fetch from EAP server if configured)
  const eapServerUrl = process.env.EAP_SERVER_URL;
  if (eapServerUrl) {
    tasks.push((async () => {
      emit("context", { source: "eap", status: "fetching" });
      try {
        // Find the latest receipt linked to this project's recordings.
        const recordings = await db
          .select({ recordingId: substrateRecordings.recordingId })
          .from(substrateRecordings)
          .where(eq(substrateRecordings.projectId, projectId))
          .orderBy(desc(substrateRecordings.createdAt))
          .limit(1);

        if (recordings.length > 0 && recordings[0].recordingId) {
          // Query EAP server for receipt chain.
          const chainRes = await fetch(
            `${eapServerUrl}/chain/${recordings[0].recordingId}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (chainRes.ok) {
            const data = await chainRes.json();
            const receipt = data.chain?.[0];
            const verification = data.verification;
            if (receipt) {
              result.eapReceipt = {
                receiptId: receipt.meta?.receipt_id ?? "",
                eventCount: receipt.meta?.event_count ?? 0,
                surfaces: {
                  httpEndpoints: receipt.surfaces?.http_endpoints ?? [],
                  dbTables: receipt.surfaces?.db_tables ?? [],
                  llmCalls: (receipt.surfaces?.llm_calls ?? []).map((c: Record<string, unknown>) => ({
                    provider: c.provider as string,
                    model: c.model as string,
                    inputTokens: c.input_tokens as number | undefined,
                    outputTokens: c.output_tokens as number | undefined,
                  })),
                  toolUses: (receipt.surfaces?.tool_uses ?? []).map((t: Record<string, unknown>) => ({
                    toolName: t.tool_name as string,
                    provider: t.provider as string,
                  })),
                },
                chainDepth: verification?.depth ?? 0,
                signed: !!receipt.signature,
                verified: verification?.all_signatures_valid ?? false,
              };
              emit("context", { source: "eap", status: "found" });
            } else {
              emit("context", { source: "eap", status: "empty" });
            }
          } else {
            emit("context", { source: "eap", status: "empty" });
          }
        } else {
          emit("context", { source: "eap", status: "empty" });
        }
      } catch {
        emit("context", { source: "eap", status: "empty" });
      }
    })());
  }

  // Run all in parallel
  await Promise.allSettled(tasks);

  return result;
}
