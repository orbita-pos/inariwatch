/**
 * Multi-integration context gathering for AI remediation.
 *
 * Before diagnosing an error, gathers ALL available context from connected
 * integrations: Sentry stack traces, Vercel build logs, GitHub CI logs,
 * Datadog monitor data. The more context the AI has, the more accurate the fix.
 */

import { db, projectIntegrations, substrateRecordings, alerts } from "@/lib/db";
import { eq, and, desc, or, ne, like, gt, count } from "drizzle-orm";
import { computeErrorFingerprint } from "./fingerprint";
import { decryptConfig } from "@/lib/crypto";
import type { RemediationContext } from "./prompts";
import { aiLog } from "./logger";
import { withServiceHealth } from "./service-health";
import * as gh from "@/lib/services/github-api";
import { getDeploymentBuildLogs, getLatestFailedDeployment } from "@/lib/services/vercel-api";

type AlertInfo = {
  title: string;
  body: string;
  sourceIntegrations: string[];
  /** VAR Q1 — when present, gatherRemediationContext fetches the FullTrace
   *  causal chain for this alert. Optional because not every caller has the
   *  id at hand (e.g. dry-run prompt builders). */
  id?: string;
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
      if (!/^[a-zA-Z0-9_-]+$/.test(org)) throw new Error("Invalid Sentry org slug");
      const titleQuery = encodeURIComponent(alert.title.replace(/\[.*?\]\s*/, "").slice(0, 80));
      const searchRes = await fetch(
        `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/issues/?query=${titleQuery}&limit=1`,
        { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 }, signal: AbortSignal.timeout(10_000) }
      );
      if (searchRes.ok) {
        const issues = await searchRes.json();
        if (issues.length > 0) issueId = issues[0].id;
      }
    } catch (e) { aiLog.warn("sentry_search_failed", { error: e instanceof Error ? e.message : String(e) }); }
  }

  if (!issueId) return { stackTrace: null, issueDetails: null };

  // Fetch latest event with stack trace
  let stackTrace: string | null = null;
  let issueDetails: string | null = null;

  try {
    const eventRes = await fetch(
      `https://sentry.io/api/0/issues/${issueId}/events/latest/`,
      { headers: { Authorization: `Bearer ${token}` }, next: { revalidate: 0 }, signal: AbortSignal.timeout(10_000) }
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
  } catch (e) { aiLog.warn("sentry_event_fetch_failed", { error: e instanceof Error ? e.message : String(e) }); }

  return { stackTrace, issueDetails };
}

// ── Vercel (fast path — direct API) ─────────────────────────────────────────

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

// ── Hosting provider build logs (Netlify, CF Pages, Render) ─────────────────
//
// Uses the RollbackProvider abstraction to fetch build logs for any hosting
// provider the project has connected. Extracts the deployment ID from the
// alert body — each host's webhook writes it as "Deploy ID:" or
// "Deployment ID:" in the alert body text.

async function fetchHostingContextFromProvider(
  projectId: string,
  alert: AlertInfo,
): Promise<string | null> {
  // Match the patterns our webhook receivers write into alert bodies.
  const patterns = [
    /Deploy(?:ment)? ID:\s*([A-Za-z0-9_-]+)/i,
    /deployment:([A-Za-z0-9_-]+)/i,
  ];
  let deploymentId: string | null = null;
  for (const p of patterns) {
    const m = alert.body.match(p);
    if (m) {
      deploymentId = m[1];
      break;
    }
  }
  if (!deploymentId) return null;

  try {
    const { findHostingProvider } = await import("@/lib/services/auto-rollback");
    const { getRollbackProvider } = await import("@/lib/providers/rollback");
    const providerConfig = await findHostingProvider(projectId);
    if (!providerConfig) return null;
    const provider = getRollbackProvider(providerConfig);
    return await provider.getBuildLogs(deploymentId);
  } catch (e) {
    aiLog.warn("hosting_context_failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
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
        signal: AbortSignal.timeout(10_000),
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

// ── Language / framework detection from manifest files ──────────────────────
//
// Pure parsers live in ./manifest-parsers.ts so they can be unit-tested
// without pulling in the db/gh dependencies this file imports. We re-export
// them here so existing callers keep importing from context-gatherer.

import type { ProjectDeps } from "./manifest-parsers";
import {
  parsePackageJson,
  parsePyprojectToml,
  parseRequirementsTxt,
  parseCargoToml,
  parseGoMod,
  parsePomXml,
  parseBuildGradle,
  parseGemfile,
} from "./manifest-parsers";

export {
  parsePackageJson,
  parsePyprojectToml,
  parseRequirementsTxt,
  parseCargoToml,
  parseGoMod,
  parsePomXml,
  parseBuildGradle,
  parseGemfile,
} from "./manifest-parsers";
export type { ProjectLanguage, ProjectDeps } from "./manifest-parsers";

/**
 * Detect a project's primary language and extract its dependency list by
 * reading whichever manifest file exists at the repo root. Tries package.json,
 * pyproject.toml, requirements.txt, Cargo.toml, go.mod, pom.xml, build.gradle,
 * Gemfile in that order — stops at the first hit.
 *
 * The returned `deps` list is intended to be fed into
 * `getStackInstructions()` from prompts.ts, which switches instructions on
 * framework name regardless of language.
 */
export async function gatherProjectDeps(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<ProjectDeps> {
  const tryRead = async (file: string): Promise<string | null> => {
    try { return await gh.getFileContent(token, owner, repo, file, ref); }
    catch { return null; }
  };

  // 1. Node.js / TypeScript — package.json
  const pkgRaw = await tryRead("package.json");
  if (pkgRaw) {
    const result = parsePackageJson(pkgRaw);
    if (result) return result;
  }

  // 2. Python — pyproject.toml (Poetry/PEP 621)
  const pyprojectRaw = await tryRead("pyproject.toml");
  if (pyprojectRaw) {
    const result = parsePyprojectToml(pyprojectRaw);
    if (result) return result;
  }

  // 3. Python — requirements.txt
  const reqRaw = await tryRead("requirements.txt");
  if (reqRaw) {
    const result = parseRequirementsTxt(reqRaw);
    if (result) return result;
  }

  // 4. Rust — Cargo.toml
  const cargoRaw = await tryRead("Cargo.toml");
  if (cargoRaw) {
    const result = parseCargoToml(cargoRaw);
    if (result) return result;
  }

  // 5. Go — go.mod
  const goRaw = await tryRead("go.mod");
  if (goRaw) {
    const result = parseGoMod(goRaw);
    if (result) return result;
  }

  // 6. Java — pom.xml
  const pomRaw = await tryRead("pom.xml");
  if (pomRaw) {
    const result = parsePomXml(pomRaw);
    if (result) return result;
  }

  // 7. Java / Kotlin — build.gradle (any flavor)
  for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
    const raw = await tryRead(gradleFile);
    if (raw) {
      const result = parseBuildGradle(raw, gradleFile);
      if (result) return result;
    }
  }

  // 8. Ruby — Gemfile
  const gemfileRaw = await tryRead("Gemfile");
  if (gemfileRaw) {
    const result = parseGemfile(gemfileRaw);
    if (result) return result;
  }

  return { language: "unknown", deps: [], source: null };
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
    codebaseContext: null,
    fixReplayContext: null,
    fullTraceContext: null,
    gitContext: null,
    breadcrumbsContext: null,
    envContext: null,
    userContext: null,
    requestContext: null,
    anomalyContext: null,
    relatedAlertsContext: null,
    impactContext: null,
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
        const ctx = await withServiceHealth("sentry", () => fetchSentryContext(token, org, alert));
        if (ctx) {
          result.sentryStackTrace = ctx.stackTrace;
          result.sentryIssueDetails = ctx.issueDetails;
        }
        emit("context", { source: "sentry", status: ctx?.stackTrace ? "found" : "empty" });
      }
    })());
  }

  // Vercel (fast path — direct Vercel API for Vercel-sourced alerts)
  const vercelInteg = integrations.find((i) => i.service === "vercel");
  if (vercelInteg && alert.sourceIntegrations.includes("vercel")) {
    tasks.push((async () => {
      emit("context", { source: "vercel", status: "fetching" });
      const config = decryptConfig(vercelInteg.configEncrypted);
      const token = config.token as string;
      const teamId = (config.teamId as string) || undefined;
      if (token) {
        result.vercelBuildLogs = await withServiceHealth("vercel", () => fetchVercelContext(token, teamId, alert, projectName));
        emit("context", { source: "vercel", status: result.vercelBuildLogs ? "found" : "empty" });
      }
    })());
  }

  // Other hosting providers (Netlify, Cloudflare Pages, Render) — uses the
  // RollbackProvider abstraction via findHostingProvider. Runs only when the
  // alert originated from a non-Vercel host, so we don't double-fetch for
  // projects that have multiple hosts connected.
  const nonVercelHostingSources = alert.sourceIntegrations.filter((s) =>
    s === "netlify" || s === "cloudflare-pages" || s === "render",
  );
  if (nonVercelHostingSources.length > 0) {
    tasks.push((async () => {
      const source = nonVercelHostingSources[0];
      emit("context", { source, status: "fetching" });
      const logs = await withServiceHealth(source, () =>
        fetchHostingContextFromProvider(integrations[0]?.projectId ?? "", alert),
      );
      // Reuse the same result field so downstream prompt building just sees
      // "build logs" regardless of which host provided them.
      if (logs) {
        result.vercelBuildLogs = logs;
      }
      emit("context", { source, status: logs ? "found" : "empty" });
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
        result.githubCILogs = await withServiceHealth("github", () => fetchGitHubCIContext(token, owner, repo, branch));
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
          const commit = await withServiceHealth("github", () => gh.getRecentCommitFiles(token, owner, repo, "main"));
          if (commit && commit.files.length > 0) {
            const fileList = commit.files
              .map((f) => `  ${f.filename} (${f.status} +${f.additions} -${f.deletions})`)
              .join("\n");
            result.deployContext = `Last deploy: ${commit.sha.slice(0, 8)} "${commit.message.split("\n")[0]}"\nFiles changed:\n${fileList}`;
          }
        }
      } catch (e) { aiLog.warn("deploy_context_failed", { error: e instanceof Error ? e.message : String(e) }); }
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
        result.datadogMetrics = await withServiceHealth("datadog", () => fetchDatadogContext(apiKey, appKey, alert));
        emit("context", { source: "datadog", status: result.datadogMetrics ? "found" : "empty" });
      }
    })());
  }

  // VAR Q1 — FullTrace causal chain. Fetches when the alert has an id we
  // can map to a session. Best-effort: any failure (DB hiccup, no
  // session, no events) falls back to result.fullTraceContext = null,
  // which the prompt builder handles by skipping the section.
  if (alert.id) {
    tasks.push((async () => {
      emit("context", { source: "fulltrace", status: "fetching" });
      try {
        const { getFullTraceContextForAlert } = await import("@/lib/fulltrace/context-for-prompt");
        const ctx = await getFullTraceContextForAlert(alert.id!);
        result.fullTraceContext = ctx;
        emit("context", { source: "fulltrace", status: ctx ? "found" : "empty" });
      } catch {
        emit("context", { source: "fulltrace", status: "empty" });
      }
    })());
  }

  // VAR Q2 Week 2 — Capture SDK v2 context. The webhook stashes git +
  // breadcrumbs in alerts.correlationData; we shape them for the LLM
  // prompt here. Best-effort — if correlationData is missing or the
  // shape is unexpected, we silently skip (old alerts from pre-0.9
  // SDK, or alerts from integrations that don't emit these fields).
  if (alert.id) {
    tasks.push((async () => {
      emit("context", { source: "capture", status: "fetching" });
      try {
        const { alerts: alertsTable } = await import("@/lib/db/schema");
        const [row] = await db
          .select({ correlationData: alertsTable.correlationData })
          .from(alertsTable)
          .where(eq(alertsTable.id, alert.id!))
          .limit(1);
        const data = (row?.correlationData ?? {}) as Record<string, unknown>;
        const {
          formatGitContext,
          formatBreadcrumbsContext,
          formatEnvContext,
          formatUserContext,
          formatRequestContext,
        } = await import("./capture-context");
        result.gitContext = formatGitContext(data.git);
        result.breadcrumbsContext = formatBreadcrumbsContext(data.breadcrumbs);
        result.envContext = formatEnvContext(data.env);
        result.userContext = formatUserContext(data.user);
        result.requestContext = formatRequestContext(data.request);
        const anyFound =
          !!(result.gitContext || result.breadcrumbsContext || result.envContext || result.userContext || result.requestContext);
        emit("context", { source: "capture", status: anyFound ? "found" : "empty" });
      } catch {
        emit("context", { source: "capture", status: "empty" });
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
  if (eapServerUrl && (eapServerUrl.startsWith("https://") || eapServerUrl.startsWith("http://localhost") || eapServerUrl.startsWith("http://127.0.0.1"))) {
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

  // Code Intelligence — stack-frame targeted RAG + broad semantic fallback
  tasks.push((async () => {
    emit("context", { source: "codebase", status: "fetching" });
    try {
      const { searchCodeByProject } = await import("@/lib/code-intelligence/search");

      // Extract function names and file paths from the stack trace for surgical queries.
      // Handles V8 (at funcName (file.ts:line)), anonymous arrows, class methods, etc.
      const stackFrames = extractStackFrames(alert.body);

      let results;
      if (stackFrames.length > 0) {
        // Run one targeted query per frame (top 4), then deduplicate by chunk id.
        const frameQueries = stackFrames.slice(0, 4).map((f) =>
          searchCodeByProject(f, projectId, { limit: 4, includeGraph: true })
        );
        const frameResults = await Promise.all(frameQueries);
        const seen = new Set<string>();
        results = frameResults.flat().filter((r) => {
          const key = `${r.filePath}:${r.startLine}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 10);

        // Fall back to broad query when frame search returns nothing.
        if (results.length === 0) {
          results = await searchCodeByProject(
            `${alert.title} ${alert.body.slice(0, 200)}`,
            projectId,
            { limit: 8, includeGraph: true },
          );
        }
      } else {
        // No recognizable stack trace — broad semantic search.
        results = await searchCodeByProject(
          `${alert.title} ${alert.body.slice(0, 200)}`,
          projectId,
          { limit: 8, includeGraph: true },
        );
      }

      if (results.length > 0) {
        const sections = results.map((r) => {
          let section = `## ${r.language} ${r.chunkType} "${r.name}" in ${r.filePath}:${r.startLine}\n`;
          if (r.docstring) section += `Purpose: ${r.docstring}\n`;
          section += `\`\`\`${r.language}\n${r.code.slice(0, 1500)}\n\`\`\``;
          if (r.callers?.length) section += `\nCalled by: ${r.callers.map((c) => `${c.name} (${c.filePath})`).join(", ")}`;
          if (r.callees?.length) section += `\nCalls: ${r.callees.map((c) => `${c.name} (${c.filePath})`).join(", ")}`;
          return section;
        });
        result.codebaseContext = sections.join("\n\n");
        emit("context", { source: "codebase", status: "found" });
      } else {
        emit("context", { source: "codebase", status: "empty" });
      }
    } catch {
      emit("context", { source: "codebase", status: "empty" });
    }
  })());

  // Fix replay — search past successful fixes by embedding similarity
  tasks.push((async () => {
    emit("context", { source: "fix-replay", status: "fetching" });
    try {
      const { searchFixReplay } = await import("@/lib/code-intelligence/fix-replay");
      // We need an embedding key — try to get one from the project owner
      const { getProjectOwnerAIKey } = await import("@/lib/ai/get-key");
      const aiKey = await getProjectOwnerAIKey(projectId);
      if (aiKey && (aiKey.provider === "openai" || aiKey.provider === "deepseek")) {
        const query = `${alert.title} ${alert.body.slice(0, 300)}`;
        const hints = await searchFixReplay(query, projectId, aiKey.key, 3);
        if (hints.length > 0) {
          const sections = hints.map((h, i) =>
            `${i + 1}. (${Math.round(h.similarity * 100)}% similar) ${h.diagnosis}\n   Files: ${h.filesFixed.join(", ")}\n   Confidence: ${h.confidence}%`
          );
          result.fixReplayContext = sections.join("\n\n");
          emit("context", { source: "fix-replay", status: "found" });
        } else {
          emit("context", { source: "fix-replay", status: "empty" });
        }
      } else {
        emit("context", { source: "fix-replay", status: "empty" });
      }
    } catch {
      emit("context", { source: "fix-replay", status: "empty" });
    }
  })());

  // P1.1 — Anomaly / Drift context from the ML poller (last 24h)
  tasks.push((async () => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await db
        .select({ title: alerts.title, aiReasoning: alerts.aiReasoning })
        .from(alerts)
        .where(
          and(
            eq(alerts.projectId, projectId),
            gt(alerts.createdAt, since),
            or(like(alerts.title, "Anomaly:%"), like(alerts.title, "Drift:%")),
          ),
        )
        .orderBy(desc(alerts.createdAt))
        .limit(5);
      if (rows.length > 0) {
        result.anomalyContext = rows
          .map((r) => `- ${r.title}${r.aiReasoning ? `: ${r.aiReasoning.slice(0, 150)}` : ""}`)
          .join("\n");
      }
    } catch { /* non-fatal */ }
  })());

  // P1.3 — Blast radius: prefer the richer `alert-impact.ts` signal
  // (distinct sessions + distinct users) when we have an alert id; fall
  // back to a plain 24h count for dry-run prompt builders that don't.
  tasks.push((async () => {
    try {
      if (alert.id) {
        const { getAlertImpact } = await import("@/lib/services/alert-impact");
        const impact = await getAlertImpact(alert.id);
        // Sessions metric is the load-bearing one for fix prioritization.
        // Users count is only meaningful when ≥1 (otherwise we have no
        // identified-user info and the number would mislead the model).
        const lines: string[] = [];
        if (impact.sessionsAffected > 0) {
          lines.push(
            impact.sessionsAffected === 1
              ? "1 session hit (isolated incident)."
              : `${impact.sessionsAffected} distinct sessions hit by the same fingerprint.`,
          );
        }
        if (impact.usersAffected > 0) {
          lines.push(`${impact.usersAffected} distinct identified user${impact.usersAffected === 1 ? "" : "s"} affected.`);
        }
        if (impact.hasFullTrace) {
          lines.push("At least one of these sessions has a recorded replay — the fix LLM can lean on the FullTrace context for the request shape.");
        }
        if (lines.length > 0) {
          result.impactContext = lines.join(" ");
          return;
        }
      }
      // No alert.id OR getAlertImpact returned empty — count-only fallback.
      const fingerprint = computeErrorFingerprint(alert.title, alert.body);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [row] = await db
        .select({ total: count() })
        .from(alerts)
        .where(
          and(
            eq(alerts.projectId, projectId),
            eq(alerts.fingerprint, fingerprint),
            gt(alerts.createdAt, since),
          ),
        );
      const total = row?.total ?? 0;
      if (total > 0) {
        result.impactContext = total === 1
          ? "1 occurrence in the last 24h (isolated incident)."
          : `${total} occurrences in the last 24h — this error is hitting multiple users or requests.`;
      }
    } catch { /* non-fatal */ }
  })());

  // P1.4 — Related alerts (10-min window) grouped by signal strength:
  // shared fingerprint → same root cause; otherwise time-only co-occurrence
  // (could still be related but lower-confidence). Previously this was
  // pure time-only which produced unrelated noise — the audit flagged it.
  if (alert.id) {
    tasks.push((async () => {
      try {
        const windowMs = 10 * 60 * 1000;
        const since = new Date(Date.now() - windowMs);
        const selfFingerprint = computeErrorFingerprint(alert.title, alert.body);

        // Same-fingerprint hits — these are almost certainly the same bug
        // recurring (different request, same root cause). Highest signal.
        const fpRows = await db
          .select({ title: alerts.title, severity: alerts.severity, fingerprint: alerts.fingerprint })
          .from(alerts)
          .where(
            and(
              eq(alerts.projectId, projectId),
              ne(alerts.id, alert.id!),
              eq(alerts.fingerprint, selfFingerprint),
              gt(alerts.createdAt, since),
            ),
          )
          .orderBy(desc(alerts.createdAt))
          .limit(3);

        // Time-only co-occurrence (DIFFERENT fingerprint) — possible
        // cascade, possible coincidence. Lower signal, smaller cap.
        const timeRows = await db
          .select({ title: alerts.title, severity: alerts.severity, fingerprint: alerts.fingerprint })
          .from(alerts)
          .where(
            and(
              eq(alerts.projectId, projectId),
              ne(alerts.id, alert.id!),
              ne(alerts.fingerprint, selfFingerprint),
              gt(alerts.createdAt, since),
            ),
          )
          .orderBy(desc(alerts.createdAt))
          .limit(3);

        const sections: string[] = [];
        if (fpRows.length > 0) {
          sections.push(
            "Same fingerprint (this exact bug recurring):\n" +
            fpRows.map((r) => `  - [${r.severity}] ${r.title}`).join("\n"),
          );
        }
        if (timeRows.length > 0) {
          sections.push(
            "Different fingerprint, same 10-min window (possible cascade or coincidence):\n" +
            timeRows.map((r) => `  - [${r.severity}] ${r.title}`).join("\n"),
          );
        }
        if (sections.length > 0) {
          result.relatedAlertsContext = sections.join("\n\n");
        }
      } catch { /* non-fatal */ }
    })());
  }

  // Run all in parallel
  await Promise.allSettled(tasks);

  return result;
}

/**
 * Parse a stack trace (Node/V8, browser, Python, Rust rustc, Go panic) and
 * return a deduplicated list of query strings for Code Intelligence lookup.
 *
 * Each query is a combination of function name + file path so the vector
 * search lands on the exact code that appears in the call chain rather than
 * doing a broad semantic scan against the full error message.
 *
 * Examples handled:
 *   at getUser (src/auth.ts:42:10)          → "getUser src/auth.ts"
 *   at UserService.findById (api/user.ts:8) → "UserService.findById api/user.ts"
 *   at async handler (app/api/route.ts:15)  → "handler app/api/route.ts"
 *   File "app/auth.py", line 42, in getUser → "getUser app/auth.py"
 */
function extractStackFrames(body: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  // V8 / Node.js: "at [async] FuncName (file.ts:line:col)" or "at file.ts:line:col"
  const v8Re = /^\s+at\s+(?:async\s+)?(?:([\w$./<>]+)\s+\()?([^):\n]+\.[a-z]{1,6}):\d+/gm;
  let m: RegExpExecArray | null;
  while ((m = v8Re.exec(body)) !== null) {
    const fn = m[1]?.replace(/^Object\.|^Module\./, "") ?? "";
    const file = m[2].replace(/^.*node_modules\/[^/]+\//, ""); // strip node_modules depth
    if (file.includes("node_modules") || file.includes("<anonymous>")) continue;
    const q = fn ? `${fn} ${file}` : file;
    if (!seen.has(q)) { seen.add(q); queries.push(q); }
  }

  // Python: 'File "path/file.py", line N, in funcName'
  const pyRe = /File "([^"]+\.py)", line \d+, in (\w+)/g;
  while ((m = pyRe.exec(body)) !== null) {
    const q = `${m[2]} ${m[1]}`;
    if (!seen.has(q)) { seen.add(q); queries.push(q); }
  }

  // Go panic: '\tpath/to/file.go:42 +0x...'  or  '\tmain.funcName(...)\n\t\tpath/to/file.go:42'
  // Two-line pattern: the function comes on one line, the file:line on the next.
  const goRe = /^\s+([\w./]+?)\.(\w+)\([^)]*\)\s*$\s+\S*?([\w./-]+\.go):\d+/gm;
  while ((m = goRe.exec(body)) !== null) {
    const fn = m[2];                                   // funcName
    const file = m[3].replace(/^.*\/(?=\w)/, "");      // strip GOPATH prefix
    if (file === "" || file.startsWith("runtime/")) continue;
    const q = `${fn} ${file}`;
    if (!seen.has(q)) { seen.add(q); queries.push(q); }
  }

  // Rust rustc panic / backtrace: 'at ./src/path/file.rs:42'  or  'src/path/file.rs:42:10'
  // rustc prefixes optional. We also catch the function via the preceding
  // 'N: module::path::funcName' line when present.
  const rustFnRe = /\d+:\s+(?:0x[\da-f]+\s+-\s+)?([\w:]+?::(\w+))(?:::h[\da-f]+)?\s*$\s+\s+at\s+\.?\/?([\w./-]+\.rs)/gm;
  while ((m = rustFnRe.exec(body)) !== null) {
    const fn = m[2];                                   // last segment after ::
    const file = m[3];
    if (file.includes("/.cargo/") || file.startsWith("rustc")) continue;
    const q = `${fn} ${file}`;
    if (!seen.has(q)) { seen.add(q); queries.push(q); }
  }
  // Standalone rust file:line:col without a function frame (compiler errors)
  const rustFileRe = /([\w./-]+\.rs):(\d+):(\d+)/g;
  while ((m = rustFileRe.exec(body)) !== null) {
    const file = m[1];
    if (file.includes("/.cargo/") || file.startsWith("rustc") || seen.has(file)) continue;
    seen.add(file);
    queries.push(file);
  }

  // Safari / WebKit: 'funcName@https://host/path/file.js:42:10'
  // Distinct from V8 because there's no 'at' prefix and the URL is full.
  const safariRe = /(?:^|\n)\s*([\w$.<>]+)?@(?:https?:\/\/[^/]+)?([^:\s]+?\.[a-z]{1,6}):\d+(?::\d+)?/g;
  while ((m = safariRe.exec(body)) !== null) {
    const fn = m[1]?.replace(/^Object\.|^Module\./, "") ?? "";
    const file = m[2].replace(/^.*node_modules\/[^/]+\//, "");
    if (file.includes("node_modules") || !fn) continue;
    const q = `${fn} ${file}`;
    if (!seen.has(q)) { seen.add(q); queries.push(q); }
  }

  return queries.slice(0, 8);
}
