/**
 * AI Remediation Engine
 *
 * Orchestrates the full fix cycle:
 *   gather context → diagnose → read code → generate fix → self-review →
 *   push → wait CI → evaluate gates → auto-merge or draft PR → monitor
 *
 * Each step updates the DB and calls `emit()` for real-time streaming to the UI.
 * If CI fails, the engine retries with context about what went wrong (up to 3 attempts).
 */

import { db, remediationSessions, alerts, projectIntegrations, projects, errorPatterns, communityFixes, substrateRecordings } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { callAI, callAIWithRetry } from "./client";
import { SYSTEM_REMEDIATOR, SYSTEM_REVIEWER, SYSTEM_TEST_GENERATOR, buildDiagnosePrompt, buildFixPrompt, buildSelfReviewPrompt, buildTestPrompt, type MemoryHint } from "./prompts";
import { expandFixFiles } from "./expand-lazy-writes";
import { computeErrorFingerprint } from "./fingerprint";
import { getProjectOwnerAIKey } from "./get-key";
import { resolveModel } from "./models";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { gatherRemediationContext } from "./context-gatherer";
import { evaluateAutoMergeGates, type SelfReviewResult } from "./auto-merge-gates";
import { startPostMergeMonitoring } from "./post-merge-monitor";
import { submitReceiptForRemediation } from "@/lib/services/eap-attestation.service";
import { linkRemediationToIncident, updateIncidentStatus, resolveIncident as resolveStatusIncident } from "./status-page-automation";
import { generatePostmortemInternal } from "./postmortem";
import { triggerEscalation, type EscalationContext } from "./escalation-engine";
import { acquireFileLocks, releaseFileLocks, canStartRemediation } from "./concurrency";
import { recordGateResult, shouldBypassGate } from "./circuit-breaker";
import { getServiceStatusSummary } from "./service-health";
import { detectIncident, resolveIncidentFollowers } from "./incident-correlation";
import { recordFailedFix, getAntiPatterns, buildAntiPatternContext, recordCalibrationPoint, adjustConfidence } from "./fix-learning";
import { DEFAULT_AUTO_MERGE_CONFIG, type AutoMergeConfig } from "@/lib/db/schema";
import type { RemediationStep } from "@/lib/db/schema";
import { createSessionLogger } from "./logger";
import {
  isCiWebhookEnabled,
  registerCiSession,
  unregisterCiSession,
  waitForCiWebhook,
} from "./ci-webhook";
import { shouldRetryCiFlake, ciFlakeBackoffMs } from "./ci-retry";

type Emit = (event: string, data: unknown) => void;

// ── Fast-path diagnosis (deterministic, no AI call) ────────────────────────

interface FastPathRule {
  titlePattern: RegExp;
  bodyFileExtractor: RegExp;
  diagnosis: string;
  confidence: number;
}

const FAST_PATH_RULES: FastPathRule[] = [
  {
    titlePattern: /Cannot read propert(?:y|ies) of (?:null|undefined)/i,
    bodyFileExtractor: /at\s+\S+\s+\(([^)]+\.[jt]sx?):(\d+)/,
    diagnosis: "Null/undefined reference — accessing a property on a nullish value",
    confidence: 92,
  },
  {
    titlePattern: /TypeError:.*is not a function/i,
    bodyFileExtractor: /at\s+\S+\s+\(([^)]+\.[jt]sx?):(\d+)/,
    diagnosis: "Type error — calling a non-function value, likely wrong import or missing method",
    confidence: 88,
  },
  {
    titlePattern: /ReferenceError:\s*(\w+) is not defined/i,
    bodyFileExtractor: /at\s+\S+\s+\(([^)]+\.[jt]sx?):(\d+)/,
    diagnosis: "Missing import or undeclared variable",
    confidence: 90,
  },
  {
    titlePattern: /Cannot find module ['"]([^'"]+)['"]/i,
    bodyFileExtractor: /at\s+\S+\s+\(([^)]+\.[jt]sx?):(\d+)/,
    diagnosis: "Missing module — either not installed or wrong import path",
    confidence: 90,
  },
  {
    titlePattern: /Property ['"](\w+)['"] does not exist on type/i,
    bodyFileExtractor: /([^(\s]+\.[jt]sx?)\((\d+),/,
    diagnosis: "TypeScript type error — property does not exist on the expected type",
    confidence: 85,
  },
  {
    titlePattern: /Argument of type .* is not assignable to/i,
    bodyFileExtractor: /([^(\s]+\.[jt]sx?)\((\d+),/,
    diagnosis: "TypeScript type mismatch — argument type incompatible with parameter",
    confidence: 85,
  },
];

function tryFastPathDiagnosis(
  title: string,
  body: string,
  repoFiles: string[],
  deployedFiles: string[],
): { diagnosis: string; filesToRead: string[]; confidence: number } | null {
  for (const rule of FAST_PATH_RULES) {
    if (!rule.titlePattern.test(title)) continue;

    const fileMatch = rule.bodyFileExtractor.exec(body);
    if (!fileMatch) continue;

    const rawPath = fileMatch[1];
    // Normalize: strip leading ./ or absolute paths, keep relative
    const normalizedPath = rawPath.replace(/^(?:\/workspace\/repo\/|\.\/|\/+)/, "");

    // Verify the file exists in the repo
    const matched = repoFiles.find((f) =>
      f === normalizedPath || f.endsWith(normalizedPath)
    );
    if (!matched) continue;

    // Prioritize deployed files if the matched file was in the deploy
    const filesToRead = [matched];
    const deployedSet = new Set(deployedFiles);
    if (!deployedSet.has(matched)) {
      const deployedRelated = deployedFiles.filter((f) =>
        f.includes(matched.split("/").slice(-2, -1)[0] ?? "")
      ).slice(0, 2);
      filesToRead.push(...deployedRelated);
    }

    return {
      diagnosis: rule.diagnosis,
      filesToRead: filesToRead.slice(0, 5),
      confidence: rule.confidence,
    };
  }

  return null;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function updateSession(
  id: string,
  data: Partial<typeof remediationSessions.$inferInsert>
) {
  await db
    .update(remediationSessions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(remediationSessions.id, id));
}

function makeStep(type: string, message: string, status: "running" | "completed" | "failed" = "running"): RemediationStep {
  return {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    message,
    status,
    timestamp: new Date().toISOString(),
  };
}

async function pushStep(
  sessionId: string,
  steps: RemediationStep[],
  step: RemediationStep,
  emit: Emit
): Promise<RemediationStep[]> {
  const updated = [...steps, step];
  await updateSession(sessionId, { steps: updated });
  emit("step", { step, steps: updated });
  return updated;
}

async function resolveStep(
  sessionId: string,
  steps: RemediationStep[],
  status: "completed" | "failed",
  message: string | undefined,
  emit: Emit
): Promise<RemediationStep[]> {
  if (steps.length === 0) return steps;
  const updated = [...steps];
  const last = { ...updated[updated.length - 1], status, ...(message ? { message } : {}) };
  updated[updated.length - 1] = last;
  await updateSession(sessionId, { steps: updated });
  emit("step_update", { step: last, steps: updated });
  return updated;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Files the AI must never touch — too risky to auto-patch
const BLOCKED_FILE_PATTERNS = [
  /^\.env(\.|$)/i,                        // .env, .env.local, .env.production
  /package-lock\.json$/,                   // npm lock file
  /yarn\.lock$/,                           // yarn lock file
  /pnpm-lock\.yaml$/,                      // pnpm lock file
  /bun\.lockb$/,                           // bun lock file
  /^\.github\/workflows\//,               // CI workflow definitions
  /^\.github\/actions\//,                 // custom actions
  /\.(sql)$/i,                             // DB migrations
  /^(migrations?|db\/migrations?)\//,     // migration folders
  /^(terraform|infra)\//,                 // infrastructure
  /\.(tf|tfvars)$/,                        // Terraform files
  /Dockerfile/i,                           // Docker build files
  /docker-compose/i,                       // Docker compose
  /\.(key|pem|cert|p12|pfx)$/i,           // Secrets and certificates
];

function isSafeFilePath(p: string): boolean {
  // Strip zero-width characters and normalize Unicode
  p = p.replace(/[\u200B\u200C\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  p = p.normalize("NFC");
  // Reject non-ASCII path separators and lookalike periods
  if (/[\u2044\u2215\uFF0F\uFF0E]/.test(p)) return false;
  if (p.includes("..") || p.startsWith("/") || p.includes("\\") || p.startsWith("~")) return false;
  if (BLOCKED_FILE_PATTERNS.some((re) => re.test(p))) return false;
  return true;
}

function getBlockedReason(p: string): string | null {
  if (p.includes("..") || p.startsWith("/")) return "path traversal";
  if (/^\.env/i.test(p)) return "environment file";
  if (/package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|bun\.lockb$/.test(p)) return "lock file (auto-generated)";
  if (/^\.github\/workflows\//.test(p)) return "CI workflow file";
  if (/\.(sql)$/i.test(p) || /^migrations?\//.test(p)) return "database migration";
  if (/\.(tf|tfvars)$/.test(p) || /^(terraform|infra)\//.test(p)) return "infrastructure config";
  if (/Dockerfile|docker-compose/i.test(p)) return "container config";
  if (/\.(key|pem|cert|p12|pfx)$/i.test(p)) return "secret/certificate file";
  return null;
}

function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) return obj[0];
  return raw;
}

/**
 * Extract repository name from an alert title.
 * Common patterns from InariWatch alerting:
 *   "CI failing on my-repo/main"
 *   "Workflow "test" failed on my-repo/develop"
 *   "Production deploy failed — my-project"
 */
function extractRepo(alertTitle: string): string | null {
  // "on {repo}/{branch}" (GitHub CI alerts)
  const onMatch = alertTitle.match(/\bon\s+([a-zA-Z0-9_.-]+)\/[a-zA-Z0-9_.-]+/);
  if (onMatch) return onMatch[1];
  // "— {project}" (Vercel deploy alerts)
  const dashMatch = alertTitle.match(/—\s+([a-zA-Z0-9_.-]+)/);
  if (dashMatch) return dashMatch[1];
  return null;
}

// ── Main engine ──────────────────────────────────────────────────────────────

// ── Pipeline phases for checkpoint/resume ────────────────────────────────────

type PipelinePhase =
  | "init" | "gather_context" | "diagnose" | "read_code" | "generate_fix"
  | "security_scan" | "self_review" | "push" | "ci_wait"
  | "staging" | "gates" | "create_pr" | "post_merge" | "completed" | "failed";

const CHECKPOINT_TTL_MS = 60 * 60 * 1000; // 1 hour — older checkpoints are stale

async function saveCheckpoint(
  sessionId: string,
  phase: PipelinePhase,
  data?: Record<string, unknown>,
  stagingDeployId?: string,
) {
  await db.update(remediationSessions)
    .set({
      checkpointPhase: phase,
      checkpointData: data ?? null,
      ...(stagingDeployId !== undefined ? { stagingDeployId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(remediationSessions.id, sessionId));
}

export async function runRemediation(sessionId: string, emit: Emit): Promise<void> {
  const log = createSessionLogger(sessionId);
  log.info("remediation_start");

  const [session] = await db.select().from(remediationSessions).where(eq(remediationSessions.id, sessionId)).limit(1);
  if (!session) { emit("error", { error: "Session not found" }); return; }

  // Cleanup orphaned staging from a previous crash
  if (session.stagingDeployId && session.checkpointPhase && session.checkpointPhase !== "completed") {
    const checkpoint = session.checkpointData as Record<string, unknown> | null;
    const age = Date.now() - new Date(session.updatedAt).getTime();
    if (age < CHECKPOINT_TTL_MS) {
      log.info("resuming_from_checkpoint", { phase: session.checkpointPhase });
      emit("resumed_from_checkpoint", { phase: session.checkpointPhase });
    }
    // Always clean up orphaned staging
    try {
      const { destroyStagingEnvironment } = await import("./staging-deploy");
      await destroyStagingEnvironment(session.stagingDeployId);
      log.info("orphan_staging_cleaned", { stagingId: session.stagingDeployId });
    } catch { /* non-blocking */ }
    await db.update(remediationSessions)
      .set({ stagingDeployId: null })
      .where(eq(remediationSessions.id, sessionId));
  }

  // Concurrency check — max 3 per project, 10 global
  if (!(await canStartRemediation(session.projectId))) {
    emit("queued", { reason: "Too many concurrent remediations. Waiting for a slot." });
    await db.update(remediationSessions)
      .set({ status: "queued" })
      .where(eq(remediationSessions.id, sessionId));
    return; // Caller should retry later
  }

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, session.alertId)).limit(1);
  if (!alert) { await fail(sessionId, emit, "Alert not found"); return; }

  // Agent (kernel-level) alerts are security detections, not code bugs — skip remediation
  if (alert.sourceIntegrations?.includes("agent")) {
    await fail(sessionId, emit, "This is a host-level security alert from the InariWatch Agent. It requires operational response (investigate process, check logs, review access), not a code fix.");
    return;
  }

  // Compute and store error fingerprint for fix replay
  const alertFingerprint = computeErrorFingerprint(alert.title, alert.body);
  await updateSession(sessionId, { fingerprint: alertFingerprint });

  // Get AI key — platform key fallback funds all users (quotas + spend guard protect)
  const aiKey = await getProjectOwnerAIKey(session.projectId);
  if (!aiKey) { await fail(sessionId, emit, "AI is temporarily unavailable. Please try again later."); return; }
  // Platform-funded remediation: reserve budget upfront ($1.00 covers a full session).
  // Per-user quotas (3/month free, 25/month pro) still enforce below.
  if (aiKey.isPlatformKey) {
    try {
      const { reservePlatformBudget } = await import("./spend-guard");
      await reservePlatformBudget(100);
    } catch (err) {
      const { PlatformBudgetExceededError } = await import("./spend-guard");
      if (err instanceof PlatformBudgetExceededError) {
        await fail(sessionId, emit, "AI budget limit reached for today. Try again tomorrow or add your own AI key in Settings for unlimited access.");
        return;
      }
      throw err;
    }
  }

  // Check quota before starting (remediations are expensive)
  try {
    const { assertWithinQuota } = await import("./quota");
    await assertWithinQuota(session.userId, "remediation");
  } catch (err) {
    const { QuotaExceededError } = await import("./quota");
    if (err instanceof QuotaExceededError) {
      await fail(sessionId, emit,
        `You've reached your monthly remediation limit (${err.used}/${err.limit}). Quota resets on the 1st of next month.`
      );
      return;
    }
    throw err;
  }

  // Find GitHub integration
  const integrations = await db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, session.projectId));
  const ghInteg = integrations.find((i) => i.service === "github");
  if (!ghInteg) { await fail(sessionId, emit, "No GitHub integration connected for this project."); return; }

  const config = decryptConfig(ghInteg.configEncrypted);
  const token = config.token as string;
  const owner = config.owner as string;
  if (!token || !owner) { await fail(sessionId, emit, "GitHub integration missing token or owner."); return; }

  // ── Canonical repo resolution (migration 0068) ────────────────────────
  // Prefer the `owner/repo` stored on the alert at ingest — that's the
  // source-of-truth from whichever webhook delivered the event. Fall back
  // to the project's `default_repo` when the source couldn't supply one
  // (custom webhooks, manual alerts, pre-0068 alerts that never got
  // backfilled). Only if BOTH are missing do we drop into the legacy
  // fuzzy-match path below — it's kept intact for alerts written before
  // the migration, but on new alerts we should never touch it.
  let fullRepo: string | null = null;
  if (alert.repo && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(alert.repo)) {
    fullRepo = alert.repo;
  } else {
    const [projRow] = await db
      .select({ defaultRepo: projects.defaultRepo })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (projRow?.defaultRepo && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(projRow.defaultRepo)) {
      fullRepo = projRow.defaultRepo;
    }
  }

  let repo: string;
  if (fullRepo) {
    const [declaredOwner, declaredRepo] = fullRepo.split("/");
    if (declaredOwner !== owner) {
      await fail(sessionId, emit,
        `This alert is tagged repo=${fullRepo} but the project's GitHub integration is for owner '${owner}'. ` +
        `Reconnect the GitHub integration under Settings → Integrations, or set a matching default repository.`
      );
      return;
    }
    repo = declaredRepo;
  } else {
    // Legacy path for alerts that predate migration 0068. Remove once
    // backfill-alert-repo.ts has populated historical rows and the oldest
    // unprocessed alerts age out of the 24h dedup window.
    const extractedRepo = extractRepo(alert.title);
    const repos = await gh.listOwnerRepos(token, owner);
    let legacyRepo = (extractedRepo && repos.includes(extractedRepo)) ? extractedRepo : null;

    if (!legacyRepo) {
      if (repos.length === 1) {
        legacyRepo = repos[0];
      } else if (repos.length > 1) {
        const alertConfig = config.alertConfig as Record<string, any> | undefined;
        const repoFilter = Array.isArray(alertConfig?.repoFilter) ? alertConfig.repoFilter : [];
        if (repoFilter.length === 1 && typeof repoFilter[0] === "string") {
          const mapped = repoFilter[0].split("/")[1];
          if (mapped && repos.includes(mapped)) legacyRepo = mapped;
        }
        if (!legacyRepo) {
          const bodyLower = alert.body.toLowerCase();
          legacyRepo = repos.find((r) => bodyLower.includes(r.toLowerCase())) ?? null;
        }
      }
    }

    if (!legacyRepo) {
      await fail(sessionId, emit,
        "Could not determine repository from alert. Set a default repository in Settings → Integrations → GitHub — " +
        "new alerts from supported sources (capture, github, vercel, sentry, datadog) carry the repo automatically."
      );
      return;
    }
    repo = legacyRepo;
    fullRepo = `${owner}/${repo}`;
  }
  let steps: RemediationStep[] = (session.steps ?? []) as RemediationStep[];

  try {
    // ── PERMISSION CHECK ───────────────────────────────────────────────────
    const perms = await gh.checkWritePermissions(token, owner, repo);
    if (!perms.canPush) {
      const scopeHint = perms.scopes
        ? `Current scopes: ${perms.scopes}`
        : "The token may be a fine-grained token — ensure it has Contents: Read and write + Pull requests: Read and write.";
      await fail(sessionId, emit,
        `Your GitHub token doesn't have write access to ${fullRepo}. ` +
        `AI remediation needs to push branches and create PRs.\n\n` +
        `Required permissions: contents: write, pull_requests: write.\n` +
        `${scopeHint}\n\n` +
        `Update your token in Integrations → GitHub → reconnect with a token that has write access.`
      );
      return;
    }

    // ── ANALYZE ────────────────────────────────────────────────────────────
    await updateSession(sessionId, { status: "analyzing", repo: fullRepo });
    emit("status", { status: "analyzing" });

    // Link this remediation session to any existing status page incident
    try { await linkRemediationToIncident(alert.id, sessionId); } catch (e) { log.warn("link_incident_failed", { error: e instanceof Error ? e.message : String(e) }); }

    steps = await pushStep(sessionId, steps,
      makeStep("analyze", "Connecting to repository and analyzing error..."), emit);

    const defaultBranch = await gh.getDefaultBranch(token, owner, repo);
    const baseSha = await gh.getBranchSha(token, owner, repo, defaultBranch);
    await updateSession(sessionId, { baseBranch: defaultBranch });

    const repoFiles = await gh.getRepoTree(token, owner, repo, baseSha);

    steps = await resolveStep(sessionId, steps, "completed",
      `Connected to ${fullRepo} (${repoFiles.length} files, branch: ${defaultBranch})`, emit);

    // ── GATHER CONTEXT FROM ALL INTEGRATIONS ──────────────────────────────
    const isVercelAlert = alert.sourceIntegrations.includes("vercel");
    const hasSentry = alert.sourceIntegrations.includes("sentry");

    steps = await pushStep(sessionId, steps,
      makeStep("gather_context", "Gathering context from all connected integrations..."), emit);

    const [proj] = await db.select().from(projects).where(eq(projects.id, session.projectId)).limit(1);
    const remediationContext = await gatherRemediationContext(
      session.projectId,
      { id: alert.id, title: alert.title, body: alert.body, sourceIntegrations: alert.sourceIntegrations },
      proj?.name ?? repo,
      emit
    );

    const contextSources = [
      remediationContext.sentryStackTrace ? "Sentry stack trace" : null,
      remediationContext.sentryIssueDetails ? "Sentry issue details" : null,
      remediationContext.vercelBuildLogs ? "Vercel build logs" : null,
      remediationContext.githubCILogs ? "GitHub CI logs" : null,
      remediationContext.datadogMetrics ? "Datadog metrics" : null,
      remediationContext.codebaseContext ? "Codebase patterns (Code RAG)" : null,
    ].filter(Boolean);

    steps = await resolveStep(sessionId, steps, "completed",
      contextSources.length > 0
        ? `Gathered context: ${contextSources.join(", ")}`
        : "No additional context found — proceeding with alert details",
      emit);

    // Persist gathered context for future replay/training
    await updateSession(sessionId, { context: remediationContext });

    // Query past sessions by fingerprint for fix replay hints
    const pastMatches = await db
      .select()
      .from(remediationSessions)
      .where(
        and(
          eq(remediationSessions.projectId, session.projectId),
          eq(remediationSessions.fingerprint, alertFingerprint),
          eq(remediationSessions.status, "completed"),
        )
      )
      .orderBy(remediationSessions.createdAt)
      .limit(3);

    const pastHints: MemoryHint[] = pastMatches
      .filter((s) => s.confidenceScore && s.confidenceScore >= 50)
      .map((s) => {
        const files = (s.fileChanges as { path: string }[] | null) ?? [];
        const stepsArr = (s.steps as RemediationStep[]) ?? [];
        return {
          alertTitle: alert.title,
          rootCause:
            stepsArr.find((st) => st.type === "diagnose" && st.status === "completed")?.message ?? "Unknown",
          fixSummary:
            stepsArr.find((st) => st.type === "generate_fix" && st.status === "completed")?.message ?? "Unknown",
          filesFixed: files.map((f) => f.path),
          confidence: s.confidenceScore ?? 0,
        };
      });

    // Query network patterns (cross-project community fixes)
    const [networkPattern] = await db
      .select()
      .from(errorPatterns)
      .where(eq(errorPatterns.fingerprint, alertFingerprint))
      .limit(1);

    if (networkPattern) {
      const networkFixes = await db
        .select()
        .from(communityFixes)
        .where(eq(communityFixes.patternId, networkPattern.id))
        .orderBy(desc(communityFixes.successCount))
        .limit(1);

      if (networkFixes.length > 0) {
        const nf = networkFixes[0];
        const successRate = nf.totalApplications > 0
          ? Math.round((nf.successCount / nf.totalApplications) * 100) : 0;

        pastHints.push({
          alertTitle: `[Network: ${networkPattern.occurrenceCount} projects] ${networkPattern.patternText}`,
          rootCause: nf.fixDescription,
          fixSummary: nf.fixApproach,
          filesFixed: nf.filesChangedSummary?.split(", ") ?? [],
          confidence: successRate,
        });
      }
    }

    if (pastHints.length > 0) {
      const networkCount = pastHints.filter((h) => h.alertTitle.startsWith("[Network")).length;
      const localCount = pastHints.length - networkCount;
      const parts = [
        localCount > 0 ? `${localCount} local` : null,
        networkCount > 0 ? `${networkCount} network` : null,
      ].filter(Boolean).join(" + ");
      steps = await pushStep(sessionId, steps,
        makeStep("memory", `Found ${pastHints.length} past fix(es) (${parts}) — injecting into diagnosis`, "completed"), emit);
    }

    // Query hot files — which files appear most frequently in past fixes for this project
    const allCompletedSessions = await db.select({ fileChanges: remediationSessions.fileChanges })
      .from(remediationSessions)
      .where(and(eq(remediationSessions.projectId, session.projectId), eq(remediationSessions.status, "completed")))
      .limit(100);

    const hotFiles = new Map<string, number>();
    for (const s of allCompletedSessions) {
      const files = (s.fileChanges as { path: string }[] | null) ?? [];
      for (const f of files) {
        if (f.path) hotFiles.set(f.path, (hotFiles.get(f.path) ?? 0) + 1);
      }
    }

    // Extract deployed files from deploy context
    const deployedFiles: string[] = [];
    if (remediationContext.deployContext) {
      const lines = remediationContext.deployContext.split("\n");
      for (const line of lines) {
        const match = line.trim().match(/^(\S+)\s+\(/);
        if (match) deployedFiles.push(match[1]);
      }
    }

    // ── INCIDENT CORRELATION ──────────────────────────────────────────
    try {
      const correlation = await detectIncident(sessionId, session.projectId, session.alertId, []);
      if (correlation.shouldWait && correlation.leaderSessionId) {
        emit("incident_follower", { incidentId: correlation.incidentId, leaderSessionId: correlation.leaderSessionId, relatedCount: correlation.relatedCount });
        steps = await pushStep(sessionId, steps,
          makeStep("incident_wait", `Part of incident with ${correlation.relatedCount} related errors — waiting for leader fix...`), emit);
        // Wait for leader to finish (poll every 30s, max 5 min)
        const waitDeadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < waitDeadline) {
          await new Promise((r) => setTimeout(r, 30_000));
          const [leader] = await db.select({ status: remediationSessions.status })
            .from(remediationSessions)
            .where(eq(remediationSessions.id, correlation.leaderSessionId!))
            .limit(1);
          if (!leader || leader.status === "failed" || leader.status === "cancelled") break; // Leader failed, proceed
          if (leader.status === "completed") {
            // Leader succeeded — resolve this session
            await resolveIncidentFollowers(correlation.incidentId!, true);
            steps = await resolveStep(sessionId, steps, "completed", "Resolved by incident leader fix", emit);
            emit("done", { status: "completed", resolvedBy: "incident_leader" });
            return;
          }
        }
        steps = await resolveStep(sessionId, steps, "completed", "Leader still running — proceeding independently", emit);
      }
    } catch (e) { log.warn("incident_correlation_failed", { error: e instanceof Error ? e.message : String(e) }); }

    const remModel = resolveModel("remediation", aiKey.provider, aiKey.modelPrefs);

    // ── FAST-PATH: deterministic diagnosis for known patterns ──────────
    // Skips the AI diagnosis call entirely (~$0.005 saved per match).
    // Patterns here are high-confidence, deterministic — the stack trace
    // alone tells us exactly what file to read and what to fix.
    const fastDiag = tryFastPathDiagnosis(alert.title, alert.body, repoFiles, deployedFiles);

    let diagnosis: { diagnosis: string; filesToRead: string[]; confidence: number };

    if (fastDiag) {
      diagnosis = fastDiag;
      steps = await pushStep(sessionId, steps,
        makeStep("diagnose", `Fast-path: ${fastDiag.diagnosis} (confidence ${fastDiag.confidence})`), emit);
      steps = await resolveStep(sessionId, steps, "completed",
        `Diagnosed via pattern match — skipped AI call`, emit);
    } else {
      steps = await pushStep(sessionId, steps,
        makeStep("diagnose", `AI is diagnosing with ${hotFiles.size > 0 ? `${hotFiles.size} hot files` : "no history"} + ${deployedFiles.length > 0 ? `${deployedFiles.length} deployed files` : "no deploy context"}...`), emit);

      let diagRaw: string;
      try {
        diagRaw = await callAIWithRetry(aiKey.key, SYSTEM_REMEDIATOR, [
          { role: "user", content: buildDiagnosePrompt({
            title: alert.title,
            body: alert.body,
            sourceIntegrations: alert.sourceIntegrations,
            aiReasoning: alert.aiReasoning,
          }, repoFiles, remediationContext, pastHints, hotFiles, deployedFiles) },
        ], {
          maxTokens: 600,
          timeout: 45000,
          model: remModel,
          provider: aiKey.provider,
          log: {
            userId: session.userId,
            projectId: session.projectId,
            alertId: session.alertId,
            remediationSessionId: session.id,
            feature: "remediation",
            isPlatformKey: aiKey.isPlatformKey,
          },
        });
      } catch (err) {
        await fail(sessionId, emit, `Diagnosis failed: ${err instanceof Error ? err.message : "AI provider error"}`);
        return;
      }

      // Diagnosis succeeded — commit the quota slot now (so failed-from-API-error
      // remediations don't waste user's quota, but committed work does count).
      try {
        const { incrementQuota } = await import("./quota");
        incrementQuota(session.userId, "remediation").catch(() => {});
      } catch {
        // Non-blocking
      }

      try {
        const parsed = JSON.parse(cleanJSON(diagRaw));
        let conf = parsed.confidence;
        if (typeof conf === "string") {
          conf = conf === "high" ? 90 : conf === "medium" ? 60 : 25;
        }
        const rawConf = Number(conf);
        diagnosis = { ...parsed, confidence: isFinite(rawConf) ? Math.max(0, Math.min(100, rawConf)) : 50 };
      } catch {
        await fail(sessionId, emit, "AI returned an invalid diagnosis. Try again.");
        return;
      }
    }

    // ── CONFIDENCE CALIBRATION ─────────────────────────────────────────
    const rawConfidence = diagnosis.confidence;
    try {
      const cal = await adjustConfidence(rawConfidence, session.projectId);
      if (cal.calibrated) {
        diagnosis.confidence = cal.adjusted;
        emit("confidence_calibrated", { raw: rawConfidence, adjusted: cal.adjusted });
        log.info("confidence_calibrated", { raw: rawConfidence, adjusted: cal.adjusted });
      }
    } catch { /* calibration failed — use raw */ }

    // ── CONFIDENCE GATING ───────────────────────────────────────────────
    if (diagnosis.confidence < 30 && isVercelAlert && !hasSentry) {
      steps = await resolveStep(sessionId, steps, "failed",
        `Low confidence (${diagnosis.confidence}%): ${diagnosis.diagnosis}`, emit);
      await fail(sessionId, emit,
        `The error information is too vague to diagnose reliably.\n\n` +
        `Diagnosis: ${diagnosis.diagnosis}\n\nConfidence: ${diagnosis.confidence}%\n\n` +
        (!remediationContext.vercelBuildLogs
          ? `The Vercel build logs could not be retrieved. Make sure the Vercel integration token has read access to deployments.\n\n`
          : "") +
        `To improve accuracy:\n` +
        `• Connect Sentry for runtime error details with stack traces\n` +
        `• Check the Vercel dashboard for the full build log\n` +
        `• If the build log shows a specific error, paste it in a comment and try again`
      );
      // Escalate: confidence too low
      try {
        await triggerEscalation({
          alertId: alert.id,
          projectId: session.projectId,
          reason: "low_confidence",
          diagnosis: diagnosis.diagnosis,
          confidence: diagnosis.confidence,
        });
      } catch (e) { log.warn("escalation_low_confidence_failed", { error: e instanceof Error ? e.message : String(e) }); }
      return;
    }

    await updateSession(sessionId, { confidenceScore: diagnosis.confidence });

    steps = await resolveStep(sessionId, steps, "completed",
      `Diagnosis (${diagnosis.confidence}% confidence): ${diagnosis.diagnosis}`, emit);

    // Emit confidence so UI can show the score badge
    emit("confidence", { score: diagnosis.confidence });

    // Update status page incident → identified
    try {
      await updateIncidentStatus({
        alertId: alert.id,
        remediationSessionId: sessionId,
        status: "identified",
        message: `Root cause identified: ${diagnosis.diagnosis.slice(0, 200)}. Automated fix in progress.`,
      });
    } catch (e) { log.warn("incident_status_update_failed", { phase: "identified", error: e instanceof Error ? e.message : String(e) }); }

    // ── FILE LOCKING ──────────────────────────────────────────────────────
    try {
      const lockResult = await acquireFileLocks(`${owner}/${repo}`, diagnosis.filesToRead, sessionId);
      if (lockResult.conflicted.length > 0) {
        emit("file_locks", { acquired: lockResult.acquired, conflicted: lockResult.conflicted });
        if (lockResult.acquired.length === 0) {
          await fail(sessionId, emit, `All target files are being modified by another remediation. Try again later.\n\nConflicted: ${lockResult.conflicted.join(", ")}`);
          return;
        }
        // Filter filesToRead to only acquired files
        diagnosis.filesToRead = diagnosis.filesToRead.filter((f) => lockResult.acquired.includes(f));
        log.info("partial_lock_acquired", { acquired: lockResult.acquired, conflicted: lockResult.conflicted });
      }
    } catch (e) { log.warn("file_lock_failed", { error: e instanceof Error ? e.message : String(e) }); }

    // ── READ CODE ──────────────────────────────────────────────────────────
    await updateSession(sessionId, { status: "reading_code" });
    emit("status", { status: "reading_code" });

    steps = await pushStep(sessionId, steps,
      makeStep("read_code", `Reading ${diagnosis.filesToRead.length} source files: ${diagnosis.filesToRead.join(", ")}...`), emit);

    const fileContents: { path: string; content: string }[] = [];
    for (const filePath of diagnosis.filesToRead.slice(0, 5)) {
      if (!isSafeFilePath(filePath)) continue; // skip traversal attempts
      const content = await gh.getFileContent(token, owner, repo, filePath, defaultBranch);
      if (content !== null) fileContents.push({ path: filePath, content });
    }
    if (fileContents.length === 0) {
      await fail(sessionId, emit, "Could not read any of the identified files from the repository.");
      return;
    }

    // ── DETECT PROJECT LANGUAGE + DEPS (language-agnostic) ──────────────
    // Checks package.json, pyproject.toml, requirements.txt, Cargo.toml,
    // go.mod, pom.xml, build.gradle, Gemfile — whichever exists first.
    let projectDeps: string[] = [];
    let stackContext = "";
    try {
      const { gatherProjectDeps } = await import("./context-gatherer");
      const detected = await gatherProjectDeps(token, owner, repo, defaultBranch);
      projectDeps = detected.deps;
      if (detected.deps.length > 0) {
        const { getStackInstructions } = await import("./prompts");
        const instructions = getStackInstructions(detected.deps);
        const header = `Language: ${detected.language} (from ${detected.source})\nDependencies: ${detected.deps.slice(0, 30).join(", ")}`;
        stackContext = instructions ? `${header}\n${instructions}` : header;
      }
    } catch { /* non-blocking — continue without stack detection */ }

    // ── FOLLOW LOCAL IMPORTS (read related files) ───────────────────────
    try {
      const importedPaths = new Set<string>();
      for (const f of fileContents) {
        const importLines = f.content.match(/^import\s+.*from\s+['"]([^'"]+)['"]/gm) ?? [];
        for (const line of importLines) {
          const match = line.match(/from\s+['"]([^'"]+)['"]/);
          if (!match) continue;
          const importPath = match[1];
          // Only follow local imports (@/, ./, ../)
          if (!importPath.startsWith("@/") && !importPath.startsWith("./") && !importPath.startsWith("../")) continue;
          // Resolve @/ to project root
          const resolved = importPath.startsWith("@/") ? importPath.slice(2) : importPath;
          // Try common extensions
          for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"]) {
            importedPaths.add(resolved + ext);
          }
        }
      }

      // Read up to 3 imported files, prioritize db/schema/types
      const priorityKeywords = ["schema", "db", "types", "model", "prisma"];
      const sorted = [...importedPaths]
        .filter((p) => !fileContents.some((f) => f.path === p || f.path.endsWith(p)))
        .sort((a, b) => {
          const aScore = priorityKeywords.some((k) => a.includes(k)) ? 0 : 1;
          const bScore = priorityKeywords.some((k) => b.includes(k)) ? 0 : 1;
          return aScore - bScore;
        });

      let importedCount = 0;
      for (const importPath of sorted) {
        if (importedCount >= 3) break;
        if (!isSafeFilePath(importPath)) continue;
        const content = await gh.getFileContent(token, owner, repo, importPath, defaultBranch);
        if (content !== null) {
          // Limit imported files to 5000 chars (enough for types/schema, not too much noise)
          fileContents.push({ path: importPath, content: content.slice(0, 5000) });
          importedCount++;
        }
      }
    } catch { /* non-blocking — continue without import following */ }

    steps = await resolveStep(sessionId, steps, "completed",
      `Read ${fileContents.length} file(s)`, emit);

    // ── ATTEMPT LOOP ───────────────────────────────────────────────────────
    let attempt = session.attempt;
    let previousAttempt: { files: { path: string; content: string }[]; ciError: string } | undefined;
    const branchName = `radar/fix-${alert.id.slice(0, 8)}-${Date.now().toString(36)}`;

    while (attempt <= session.maxAttempts) {
      await updateSession(sessionId, { attempt, status: "generating_fix" });
      emit("status", { status: "generating_fix" });

      // ── GENERATE FIX ───────────────────────────────────────────────────

      let fix: { explanation: string; files: { path: string; content: string }[] } = null!;
      let managedAgentPushed = false; // If true, skip our own push — agent already pushed
      let managedBranch: string | null = null; // Branch name from Managed Agent (different from branchName)
      let containerVerified = false; // If true, fix was verified (tsc+build) in container — boosts gate confidence
      // Fase 4 — tri-state from the Hetzner worker's pre-push hooks. True
      // only when tsc / npm test / npm run lint all actually ran AND all
      // passed inside the container. Null when PREPUSH_TESTS_ENABLED was
      // off, or when the non-worker path ran (Vercel container / agentic
      // loop / managed agent — none of which have Fase 4 hooks). Gates
      // the Part C intelligent CI retry below.
      let prepushPassed: boolean | null = null;

      // ── MANAGED AGENT (first attempt, if enabled) ─────────────────────
      // The agent clones the repo, explores, fixes, verifies (tsc/build/test), and pushes.
      // Falls back to agentic loop if Managed Agent fails.
      const managedAgentEnabled = process.env.MANAGED_AGENT_ENABLED?.toLowerCase() === "true" || process.env.MANAGED_AGENT_ENABLED === "1";
      const useManagedAgent = attempt === 1 && !previousAttempt && managedAgentEnabled;

      if (useManagedAgent) {
        steps = await pushStep(sessionId, steps,
          makeStep("generate_fix", "Managed Agent is cloning the repo and fixing the bug..."), emit);

        try {
          const { runManagedRemediation } = await import("./managed-agent");
          // Managed Agents are disabled (MANAGED_AGENT_ENABLED=false) — use resolved key
          const agentApiKey = aiKey.key;

          const additionalContext = [
            remediationContext?.sentryStackTrace ? `SENTRY:\n${remediationContext.sentryStackTrace.slice(0, 2000)}` : "",
            remediationContext?.vercelBuildLogs ? `BUILD LOGS:\n${remediationContext.vercelBuildLogs.slice(0, 2000)}` : "",
            remediationContext?.codebaseContext ? `CODEBASE:\n${remediationContext.codebaseContext.slice(0, 3000)}` : "",
          ].filter(Boolean).join("\n\n");

          const managedResult = await runManagedRemediation({
            apiKey: agentApiKey,
            errorTitle: alert.title,
            stackTrace: alert.body.slice(0, 4000),
            severity: alert.severity,
            errorFile: diagnosis.filesToRead?.[0],
            repositoryUrl: `https://github.com/${fullRepo}`,
            branch: defaultBranch,
            githubToken: token,
            projectId: session.projectId,
            alertId: alert.id,
            additionalContext,
            emit: (event: string, data: Record<string, unknown>) => emit(event, data),
          });

          if (managedResult.status === "success" && managedResult.branch) {
            // Agent already pushed — we don't need to push again
            managedAgentPushed = true;
            fix = {
              explanation: managedResult.explanation ?? "Fix generated by Managed Agent",
              files: managedResult.files ?? [],
            };

            managedBranch = managedResult.branch;

            steps = await resolveStep(sessionId, steps, "completed",
              `Managed Agent fixed and pushed in ${managedResult.turns ?? "?"} steps${managedResult.verified ? " (verified: tsc + build pass)" : ""}`, emit);
          } else {
            // Managed Agent failed — fall through to agentic loop
            log.warn("managed_agent_fallback", { status: managedResult.status, reason: managedResult.reason });
            steps = await resolveStep(sessionId, steps, "completed",
              `Managed Agent: ${managedResult.reason?.slice(0, 100) ?? "failed"} — falling back`, emit);
          }
        } catch (managedErr) {
          log.warn("managed_agent_error", { error: managedErr instanceof Error ? managedErr.message : String(managedErr) });
          steps = await resolveStep(sessionId, steps, "completed",
            "Managed Agent unavailable — falling back to agentic exploration", emit);
        }
      }

      // ── CONTAINER AGENT (Hetzner — fix + verify in Docker container) ────
      // The AI explores and fixes code inside a container with shell access.
      // Can run tsc/build/test before pushing — only verified code leaves.
      // Falls back to agentic loop if container is unavailable.
      const containerAgentEnabled = !!process.env.STAGING_SERVER_URL
        && (process.env.CONTAINER_AGENT_ENABLED?.toLowerCase() === "true" || process.env.CONTAINER_AGENT_ENABLED === "1");
      const useContainerAgent = !fix && attempt === 1 && !previousAttempt && containerAgentEnabled;

      if (useContainerAgent) {
        steps = await pushStep(sessionId, steps,
          makeStep("generate_fix", "Container agent is cloning the repo and fixing the bug..."), emit);

        try {
          // Use the resolved AI key (platform OpenAI or user's BYOK key)
          const { resolveModel } = await import("./models");
          const containerApiKey = aiKey.key;
          const containerProvider = aiKey.provider;
          const containerExplore = resolveModel("analysis", aiKey.provider, aiKey.modelPrefs);
          const containerFix = resolveModel("remediation", aiKey.provider, aiKey.modelPrefs);

          // Wrap untrusted fields (alert body, external integration payloads)
          // in <untrusted> tags — combined with IMMUTABLE_RULES rule #5 this
          // is our spotlighting defense against prompt injection via error
          // messages, stack traces, CI logs, etc. codebaseContext comes from
          // our own Code Intelligence service so we trust it as-is.
          const { wrapUntrusted } = await import("./prompts");
          const errorContext = [
            `ERROR: ${alert.title}`,
            `SEVERITY: ${alert.severity}`,
            `STACK TRACE:\n${wrapUntrusted(alert.body.slice(0, 3000), "alert_body")}`,
            remediationContext?.sentryStackTrace ? `\nSENTRY:\n${wrapUntrusted(remediationContext.sentryStackTrace.slice(0, 2000), "sentry_stack")}` : "",
            remediationContext?.vercelBuildLogs ? `\nBUILD LOGS:\n${wrapUntrusted(remediationContext.vercelBuildLogs.slice(0, 2000), "vercel_build")}` : "",
            remediationContext?.githubCILogs ? `\nCI LOGS:\n${wrapUntrusted(remediationContext.githubCILogs.slice(0, 2000), "github_ci")}` : "",
            remediationContext?.codebaseContext ? `\nCODEBASE PATTERNS:\n${remediationContext.codebaseContext.slice(0, 4000)}` : "",
          ].filter(Boolean).join("\n\n");

          // ── Try Hetzner worker first (AI loop on localhost = no latency) ──
          const workerUrl = process.env.WORKER_URL;
          const isSecureWorkerUrl = workerUrl && (workerUrl.startsWith("https://") || workerUrl.startsWith("http://localhost") || workerUrl.startsWith("http://127.0.0.1"));
          if (workerUrl && isSecureWorkerUrl) {
            emit("container_agent", { status: "dispatching" });
            const jobRes = await fetch(`${workerUrl}/worker/run`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${process.env.STAGING_API_SECRET}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId, repoUrl: `https://github.com/${fullRepo}.git`, branch: defaultBranch,
                githubToken: token, aiKey: containerApiKey, aiProvider: containerProvider,
                exploreModel: containerExplore, fixModel: containerFix, errorContext, maxTurns: 40,
                // Fase 2b — worker uses this to try /pool/checkout before
                // cold-spawning when CONTAINER_POOL_ENABLED=true on the
                // worker host. Older workers ignore it.
                projectId: session.projectId,
              }),
              signal: AbortSignal.timeout(10_000),
            });

            if (!jobRes.ok) throw new Error(`Worker dispatch failed (${jobRes.status})`);
            const { jobId } = await jobRes.json() as { jobId: string };
            emit("container_agent", { status: "running", jobId });

            // Poll for completion (worker writes steps to DB, SSE reads them).
            // PR #8 (2026-04-21): bumped 8min -> 15min because gVisor + mitmproxy
            // add ~2x latency; Stage 2.5 hit the 8min cap at turn 19/40 and
            // had to fall back to agentic-loop, defeating the point of the
            // hardened sandbox.  15min covers the full 40-turn budget under
            // worst-case gVisor overhead.
            const pollStart = Date.now();
            const maxPollMs = 15 * 60 * 1000;
            // Fase 4 — prepushPassed is a tri-state: true when the worker
            // verified via tsc/test/lint; false when the field was explicitly
            // reported false (defensive — worker never returns false on a
            // submit_fix terminal path, but the type is conservative);
            // null when the worker didn't run pre-push (flag off or old
            // worker version). Older workers omit the field entirely and we
            // coerce `undefined` → `null` below.
            type WorkerResult = {
              explanation: string;
              files: { path: string; content: string }[];
              turns: number;
              verified: boolean;
              testsPassed: boolean;
              prepushPassed?: boolean | null;
            };
            let workerResult: WorkerResult | null = null;

            while (Date.now() - pollStart < maxPollMs) {
              await new Promise((r) => setTimeout(r, 3000));

              // Forward fresh steps from DB to SSE
              const [freshSession] = await db.select({ steps: remediationSessions.steps })
                .from(remediationSessions).where(eq(remediationSessions.id, sessionId)).limit(1);
              const freshSteps = (freshSession?.steps ?? []) as RemediationStep[];
              if (freshSteps.length > steps.length) {
                for (let i = steps.length; i < freshSteps.length; i++) {
                  emit("step", { step: freshSteps[i], steps: freshSteps });
                }
                steps = freshSteps;
              }

              const statusRes = await fetch(`${workerUrl}/worker/job/${jobId}`, {
                headers: { "Authorization": `Bearer ${process.env.STAGING_API_SECRET}` },
                signal: AbortSignal.timeout(5_000),
              });
              const jobStatus = await statusRes.json() as { status: string; result?: WorkerResult; error?: string };

              if (jobStatus.status === "completed" && jobStatus.result) {
                workerResult = jobStatus.result;
                break;
              }
              if (jobStatus.status === "failed") {
                throw new Error(jobStatus.error ?? "Worker job failed");
              }
            }

            if (!workerResult) throw new Error("Worker job timed out");

            fix = { explanation: workerResult.explanation, files: workerResult.files };
            containerVerified = workerResult.verified;
            prepushPassed = workerResult.prepushPassed ?? null;

            steps = await resolveStep(sessionId, steps, "completed",
              `Container agent fixed in ${workerResult.turns} turns (tsc: ${workerResult.verified ? "✅" : "❌"}, tests: ${workerResult.testsPassed ? "✅" : "⚠"}${prepushPassed === true ? ", prepush: ✅" : ""})`, emit);
          } else {
            // ── Fallback: run container agent on Vercel (original path) ──
            const { runContainerAgent, createContainer, destroyContainer } = await import("./container-agent");
            let containerId: string | null = null;

            try {
              emit("container_agent", { status: "creating" });
              containerId = await createContainer(
                process.env.STAGING_SERVER_URL!, process.env.STAGING_API_SECRET!,
                `https://github.com/${fullRepo}.git`, defaultBranch, token, sessionId,
              );
              emit("container_agent", { status: "ready", containerId });

              const containerResult = await runContainerAgent({
                apiKey: containerApiKey, provider: containerProvider,
                exploreModel: containerExplore, fixModel: containerFix, errorContext,
                containerUrl: process.env.STAGING_SERVER_URL!, containerId,
                stagingSecret: process.env.STAGING_API_SECRET!,
                emit: (event: string, data: Record<string, unknown>) => emit(event, data),
                log: {
                  userId: session.userId,
                  projectId: session.projectId,
                  alertId: session.alertId,
                  remediationSessionId: sessionId,
                  isPlatformKey: aiKey.isPlatformKey,
                },
              });

              fix = { explanation: containerResult.explanation, files: containerResult.files };
              containerVerified = containerResult.verified;

              steps = await resolveStep(sessionId, steps, "completed",
                `Container agent fixed in ${containerResult.turns} turns (tsc: ${containerResult.verified ? "✅" : "❌"}, tests: ${containerResult.testsPassed ? "✅" : "⚠"})`, emit);

              destroyContainer(process.env.STAGING_SERVER_URL!, process.env.STAGING_API_SECRET!, containerId).catch(() => {});
            } finally {
              if (containerId) {
                const { destroyContainer: dc } = await import("./container-agent");
                dc(process.env.STAGING_SERVER_URL!, process.env.STAGING_API_SECRET!, containerId).catch(() => {});
              }
            }
          }
        } catch (containerErr) {
          log.warn("container_agent_fallback", { error: containerErr instanceof Error ? containerErr.message : String(containerErr) });
          steps = await resolveStep(sessionId, steps, "completed",
            "Container agent unavailable — falling back to agentic exploration", emit);
        }
      }

      // ── DETERMINISTIC TEMPLATE FAST-PATH (PR #9) ───────────────────
      // Before burning an agentic loop, check whether the diagnosis +
      // source file match a known-pattern we can fix without an LLM.
      // The generated patch still runs through the verifier before
      // anything ships, so a bad template never reaches prod.
      if (!fix && attempt === 1 && !previousAttempt) {
        try {
          const { tryDeterministicFix } = await import("./templates");
          const { verifyFix } = await import("./verifier");
          const candidate = tryDeterministicFix(fileContents, diagnosis.diagnosis);
          if (candidate) {
            const originalsMap = new Map<string, string>();
            for (const f of fileContents) originalsMap.set(f.path, f.content);
            const { resolveModel: rm } = await import("./models");
            const verify = await verifyFix({
              files: [{ path: candidate.fix.path, content: candidate.fix.content }],
              originalFiles: originalsMap,
              errorContext: `${alert.title}\n\n${alert.body.slice(0, 2000)}`,
              diagnosis: diagnosis.diagnosis,
              apiKey: aiKey.key,
              model: rm("analysis", aiKey.provider, aiKey.modelPrefs),
              skipSanity: false,
              log: {
                userId: session.userId,
                projectId: session.projectId,
                alertId: session.alertId,
                remediationSessionId: sessionId,
                isPlatformKey: aiKey.isPlatformKey,
              },
            });
            if (verify.ok) {
              emit("template_fix", {
                pattern: "non-null-await",
                path: candidate.match.path,
                line: candidate.match.line,
                varName: candidate.match.varName,
              });
              fix = {
                explanation: candidate.fix.explanation,
                files: [{ path: candidate.fix.path, content: candidate.fix.content }],
              };
              log.info("template_fix_applied", {
                pattern: "non-null-await",
                path: candidate.match.path,
              });
            } else {
              log.info("template_fix_rejected_by_verifier", {
                pattern: "non-null-await",
                issue: verify.issue,
              });
            }
          }
        } catch (e) {
          log.warn("template_fix_errored", { error: e instanceof Error ? e.message : String(e) });
          // Fall through to the agentic loop — template is an
          // optimisation, not a requirement.
        }
      }

      // ── AGENTIC LOOP (fallback if Container Agent / Managed Agent didn't produce a fix) ──
      const supportsToolUse = aiKey.provider !== "gemini";
      const useAgentic = !fix && attempt === 1 && supportsToolUse && !previousAttempt;

      if (useAgentic) {
        steps = await pushStep(sessionId, steps,
          makeStep("generate_fix", "AI is exploring the codebase to understand and fix the bug..."), emit);

        try {
          const { runAgenticLoop } = await import("./agentic-loop");

          // Same spotlighting wrap as the container-agent path — alert body
          // and external integration payloads go inside <untrusted> tags.
          const { wrapUntrusted } = await import("./prompts");
          const errorContext = [
            `ERROR: ${alert.title}`,
            `SEVERITY: ${alert.severity}`,
            `STACK TRACE:\n${wrapUntrusted(alert.body.slice(0, 3000), "alert_body")}`,
            remediationContext?.sentryStackTrace ? `\nSENTRY:\n${wrapUntrusted(remediationContext.sentryStackTrace.slice(0, 2000), "sentry_stack")}` : "",
            remediationContext?.vercelBuildLogs ? `\nBUILD LOGS:\n${wrapUntrusted(remediationContext.vercelBuildLogs.slice(0, 2000), "vercel_build")}` : "",
            remediationContext?.githubCILogs ? `\nCI LOGS:\n${wrapUntrusted(remediationContext.githubCILogs.slice(0, 2000), "github_ci")}` : "",
            remediationContext?.codebaseContext ? `\nCODEBASE PATTERNS:\n${remediationContext.codebaseContext.slice(0, 4000)}` : "",
          ].filter(Boolean).join("\n\n");

          // Use the resolved AI key (platform OpenAI or user's BYOK key)
          const { resolveModel } = await import("./models");
          const agenticApiKey = aiKey.key;
          const agenticProvider = aiKey.provider;
          const agenticExplore = resolveModel("analysis", aiKey.provider, aiKey.modelPrefs);
          const agenticFix = resolveModel("remediation", aiKey.provider, aiKey.modelPrefs);

          // PR #7 context pre-fetch: the diagnose step already fetched
          // diagnosis.filesToRead (fileContents). Use those as seeds and
          // auto-pull 1 hop of relative imports so the agent starts with
          // warm context instead of burning turns on read_file.
          const prefetchedFiles = new Map<string, string>();
          try {
            const { prefetchContext } = await import("./context-prefetch");
            const seedPaths = fileContents.map((f) => f.path);
            const result = await prefetchContext(
              gh,
              token,
              owner,
              repo,
              defaultBranch,
              seedPaths,
              repoFiles,
              { maxFiles: 8, maxHops: 1 },
            );
            for (const [p, c] of result.files) prefetchedFiles.set(p, c);
            emit("prefetch_context", {
              seeds: result.sources.seeds.length,
              imports: result.sources.imports.length,
              skipped: result.skipped.length,
            });
          } catch (e) {
            log.warn("prefetch_context_failed", { error: e instanceof Error ? e.message : String(e) });
            // Fall through — the agentic loop will just read_file as
            // before. Pre-fetch is an optimization, not a requirement.
            for (const f of fileContents) prefetchedFiles.set(f.path, f.content);
          }

          // If this remediation was triggered from a Replay V2 session, its
          // sessionId is stored on session.context — thread it through so the
          // in-loop substrate replay gate sees the user's browser journey
          // alongside the raw backend I/O (loader is tenant-scoped by
          // projectId, so an untrusted value can't leak cross-tenant data).
          const agenticCtx = session.context as { replaySessionId?: string } | null;
          const agenticReplaySessionId =
            typeof agenticCtx?.replaySessionId === "string" ? agenticCtx.replaySessionId : undefined;

          const agenticResult = await runAgenticLoop({
            apiKey: agenticApiKey,
            provider: agenticProvider,
            exploreModel: agenticExplore,
            fixModel: agenticFix,
            // PR #6: verifier uses the analysis-tier model (mini/haiku).
            // Cheap, deterministic-ish, and doesn't compete with the fix
            // model's reasoning budget.
            verifyModel: agenticExplore,
            diagnosisText: diagnosis.diagnosis,
            replaySessionId: agenticReplaySessionId,
            prefetchedFiles,
            systemPrompt: "",
            errorContext,
            token,
            owner,
            repo,
            defaultBranch,
            projectId: session.projectId,
            repoFiles: repoFiles.slice(0, 500),
            emit: (event: string, data: Record<string, unknown>) => emit(event, data),
            log: {
              userId: session.userId,
              alertId: session.alertId,
              remediationSessionId: sessionId,
              isPlatformKey: aiKey.isPlatformKey,
            },
          });

          fix = { explanation: agenticResult.explanation, files: agenticResult.files };
        } catch (agenticErr) {
          // Agentic loop failed — fall back to single-shot for this attempt
          log.warn("agentic_loop_failed_fallback", { error: agenticErr instanceof Error ? agenticErr.message : String(agenticErr) });

          steps = await resolveStep(sessionId, steps, "completed",
            "Agentic exploration failed — falling back to standard fix generation", emit);
          steps = await pushStep(sessionId, steps,
            makeStep("generate_fix", "AI is generating a code fix (standard mode)..."), emit);

          // Fall through to single-shot below
          fix = null!;
        }
      }

      // Single-shot fix generation (retries, non-Claude, or agentic fallback)
      if (!fix) {
        steps = await pushStep(sessionId, steps,
          makeStep("generate_fix", attempt > 1
            ? `Attempt ${attempt}/${session.maxAttempts}: Generating a different fix based on the CI failure...`
            : "AI is generating a code fix..."), emit);

        // ── ANTI-PATTERN INJECTION ──────────────────────────────────────
        let antiPatternCtx: string | undefined;
        try {
          const patterns = await getAntiPatterns(session.projectId, alertFingerprint, diagnosis.filesToRead);
          if (patterns.length > 0) {
            antiPatternCtx = buildAntiPatternContext(patterns);
            emit("anti_patterns", { count: patterns.length });
          }
        } catch { /* non-blocking */ }

        let fixRaw: string;
        try {
          // Compose SYSTEM_REMEDIATOR with IMMUTABLE_RULES dual-point + GPT
          // overlays when the active fix model is GPT-like. This extends
          // PR #2 coverage to the single-shot retry path that doesn't go
          // through the agent tool loop.
          const { buildGPTRemediationSystemPrompt } = await import("./prompts");
          const systemWithOverlays = buildGPTRemediationSystemPrompt(SYSTEM_REMEDIATOR, remModel);
          fixRaw = await callAIWithRetry(aiKey.key, systemWithOverlays, [
            { role: "user", content: buildFixPrompt(diagnosis.diagnosis, fileContents, alert.body, previousAttempt, remediationContext?.codebaseContext, antiPatternCtx, stackContext) },
          ], {
            maxTokens: 4096,
            timeout: 60000,
            model: remModel,
            provider: aiKey.provider,
            log: {
              userId: session.userId,
              projectId: session.projectId,
              alertId: session.alertId,
              remediationSessionId: session.id,
              feature: "remediation",
              isPlatformKey: aiKey.isPlatformKey,
            },
          });
        } catch (err) {
          await fail(sessionId, emit, `Fix generation failed: ${err instanceof Error ? err.message : "AI provider error"}`);
          return;
        }

        try {
          fix = JSON.parse(cleanJSON(fixRaw));
        } catch {
          steps = await resolveStep(sessionId, steps, "failed", "AI returned invalid fix format", emit);
          if (attempt >= session.maxAttempts) {
            await fail(sessionId, emit, "AI could not generate a valid fix after all attempts.");
            return;
          }
          attempt++;
          continue;
        }
      } // end if (!fix) — single-shot path

      if (!fix.files?.length && !managedAgentPushed) {
        await fail(sessionId, emit, "AI could not determine what code to change.");
        return;
      }

      // Validate file paths — reject dangerous or blocked files
      // Skip validation when Managed Agent already pushed (files fetched for review only, not for push)
      if (!managedAgentPushed) {
        const blockedFiles: string[] = [];
        fix.files = fix.files.filter((f) => {
          const reason = getBlockedReason(f.path);
          if (reason) { blockedFiles.push(`${f.path} (${reason})`); return false; }
          return true;
        });
        if (!fix.files.length) {
          const blocked = blockedFiles.length ? `\n\nBlocked files: ${blockedFiles.join(", ")}` : "";
          await fail(sessionId, emit, `AI tried to modify protected files that cannot be auto-patched.${blocked}`);
          return;
        }
        if (blockedFiles.length > 0) {
          emit("warning", { message: `Skipped protected files: ${blockedFiles.join(", ")}` });
        }

        // Expand lazy-write markers ("// ... keep existing code ...") against originals.
        // The AI now outputs only changed lines + markers to reduce output tokens by 60-80%.
        const originalsMap = new Map(fileContents.map((f) => [f.path, f.content]));
        fix.files = expandFixFiles(fix.files, originalsMap);
      } // end if (!managedAgentPushed) — blocked file validation

      await updateSession(sessionId, { fileChanges: fix.files });

      // Emit diff so UI can show a preview of what will change
      emit("diff", { files: fix.files.map((f) => ({ path: f.path, lines: f.content.split("\n").length })) });

      steps = await resolveStep(sessionId, steps, "completed",
        `Fix: ${fix.explanation}`, emit);

      // ── REGRESSION TEST GENERATION ─────────────────────────────────
      steps = await pushStep(sessionId, steps,
        makeStep("test_gen", "Generating regression test for the fix..."), emit);

      try {
        // Find existing test files in the repo to learn conventions
        const testFiles: { path: string; content: string }[] = [];
        const testPatterns = [/__tests__\//, /\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, /_test\.go$/, /_test\.py$/];
        const candidateTestFiles = repoFiles
          .filter((f) => testPatterns.some((p) => p.test(f)))
          .slice(0, 3);

        for (const tf of candidateTestFiles) {
          const testContent = await gh.getFileContent(token, owner, repo, tf, defaultBranch);
          if (testContent) testFiles.push({ path: tf, content: testContent });
        }

        const testRaw = await callAI(aiKey.key, SYSTEM_TEST_GENERATOR, [
          {
            role: "user",
            content: buildTestPrompt(
              diagnosis.diagnosis,
              fileContents,
              fix.files,
              alert.body,
              testFiles.length > 0 ? testFiles : undefined,
              remediationContext?.codebaseContext
            ),
          },
        ], {
          maxTokens: 2048,
          timeout: 45000,
          model: remModel,
          provider: aiKey.provider,
          log: {
            userId: session.userId,
            projectId: session.projectId,
            alertId: session.alertId,
            remediationSessionId: session.id,
            feature: "remediation",
            isPlatformKey: aiKey.isPlatformKey,
          },
        });

        const testResult: { files: { path: string; content: string }[]; description: string } = JSON.parse(cleanJSON(testRaw));

        if (testResult.files?.length > 0) {
          // Validate test file paths through the same safety check as fix files
          const safeTestFiles = testResult.files.filter((f) => isSafeFilePath(f.path));
          // Merge safe test files with fix files (CI will run them)
          fix.files = [...fix.files, ...safeTestFiles];
          await updateSession(sessionId, { fileChanges: fix.files });
          steps = await resolveStep(sessionId, steps, "completed",
            `Generated ${testResult.files.length} regression test(s): ${testResult.description}`, emit);
        } else {
          steps = await resolveStep(sessionId, steps, "completed",
            "No regression test generated (fix may not benefit from one)", emit);
        }
      } catch {
        // Non-blocking — fix still works without tests
        steps = await resolveStep(sessionId, steps, "completed",
          "Regression test generation skipped (non-blocking)", emit);
      }

      // ── SECURITY SCAN ────────────────────────────────────────────────
      // Managed Agent pushes directly — fix.files may be empty.
      // Fetch actual changed files from GitHub for security scan + self-review.
      if (managedAgentPushed && (!fix.files || fix.files.length === 0) && managedBranch) {
        try {
          const changedPaths = await gh.getRecentCommitFiles(token, owner, repo, managedBranch);
          if (changedPaths?.files) {
            for (const f of changedPaths.files.slice(0, 10)) {
              const content = await gh.getFileContent(token, owner, repo, f.filename, managedBranch);
              if (content) fix.files.push({ path: f.filename, content });
            }
          }
        } catch { /* non-blocking — proceed with what we have */ }
      }

      let securityHighCount: number | null = null;
      steps = await pushStep(sessionId, steps,
        makeStep("security_scan", "Running security scan on generated fix..."), emit);

      try {
        const { scanFiles, aiSecurityReview } = await import("./security-scan");
        const scanResult = scanFiles(fix.files);

        // AI security review — async, non-blocking enhancement
        try {
          const scanModel = resolveModel("analysis", aiKey.provider, aiKey.modelPrefs);
          const callAIScan = (key: string, system: string, msgs: { role: "user"; content: string }[]) =>
            callAI(key, system, msgs, {
              model: scanModel,
              provider: aiKey.provider,
              log: {
                userId: session.userId,
                projectId: session.projectId,
                alertId: session.alertId,
                remediationSessionId: session.id,
                feature: "security-scan",
                isPlatformKey: aiKey.isPlatformKey,
              },
            });
          const aiFindings = await aiSecurityReview(fix.files, callAIScan, aiKey.key);
          for (const f of aiFindings) {
            const exists = scanResult.findings.some(
              (e) => e.file === f.file && e.line === f.line && e.rule === f.rule
            );
            if (!exists) scanResult.findings.push(f);
          }
          // Recalculate counts after merging AI findings
          scanResult.highCount = scanResult.findings.filter(f => f.severity === "HIGH").length;
          scanResult.mediumCount = scanResult.findings.filter(f => f.severity === "MEDIUM").length;
          scanResult.lowCount = scanResult.findings.filter(f => f.severity === "LOW").length;
          scanResult.passed = scanResult.highCount === 0;
        } catch {
          // AI review failure is non-blocking
        }

        securityHighCount = scanResult.highCount;

        if (scanResult.highCount > 0) {
          steps = await resolveStep(sessionId, steps, "failed",
            `Security scan: ${scanResult.highCount} HIGH finding(s) — ${scanResult.findings.filter(f => f.severity === "HIGH").map(f => f.message).join("; ")}`, emit);
          // Don't abort — flag for self-review awareness, continue to PR as draft
        } else {
          steps = await resolveStep(sessionId, steps, "completed",
            `Security scan passed (${scanResult.findings.length} total findings, 0 HIGH)`, emit);
        }

        await updateSession(sessionId, {
          context: {
            ...(typeof session.context === "object" && session.context ? session.context : {}),
            securityScan: { passed: scanResult.passed, highCount: scanResult.highCount, mediumCount: scanResult.mediumCount, findings: scanResult.findings.slice(0, 10) },
          },
        });
      } catch {
        steps = await resolveStep(sessionId, steps, "completed",
          "Security scan skipped (non-blocking)", emit);
      }

      // ── SELF-REVIEW (cascaded: cheap model first, escalate if ambiguous) ─
      let selfReview: SelfReviewResult | null = null;
      steps = await pushStep(sessionId, steps,
        makeStep("self_review", "AI is reviewing the generated fix for correctness..."), emit);

      const reviewPromptMessages = [
        { role: "user" as const, content: buildSelfReviewPrompt(
          diagnosis.diagnosis, fileContents, fix.files, alert.body
        ) },
      ];
      const reviewLogCtx = {
        userId: session.userId,
        projectId: session.projectId,
        alertId: session.alertId,
        remediationSessionId: session.id,
        feature: "self-review" as const,
        isPlatformKey: aiKey.isPlatformKey,
      };

      try {
        // Tier 0: cheap model (Haiku / GPT-4o-mini)
        const cheapModel = resolveModel("analysis", aiKey.provider, aiKey.modelPrefs);
        const { buildGPTRemediationSystemPrompt: withOverlays } = await import("./prompts");
        const reviewerWithOverlays = withOverlays(SYSTEM_REVIEWER, cheapModel);
        const reviewRaw = await callAI(aiKey.key, reviewerWithOverlays, reviewPromptMessages, {
          maxTokens: 512,
          timeout: 30000,
          model: cheapModel,
          provider: aiKey.provider,
          log: reviewLogCtx,
        });

        const parsed = JSON.parse(cleanJSON(reviewRaw));
        selfReview = {
          score: isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Number(parsed.score))) : 50,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
          recommendation: ["approve", "flag", "reject"].includes(parsed.recommendation) ? parsed.recommendation : "flag",
        };

        // Cascade: if score is in the ambiguous zone (40-70), escalate to
        // the remediation-tier model for a second opinion. Clear approve (>70)
        // or clear reject (<40) don't need a more expensive model.
        if (selfReview.score >= 40 && selfReview.score <= 70) {
          try {
            const strongModel = resolveModel("remediation", aiKey.provider, aiKey.modelPrefs);
            if (strongModel !== cheapModel) {
              emit("self_review_escalating", { cheapScore: selfReview.score, model: strongModel });
              const strongReviewerWithOverlays = withOverlays(SYSTEM_REVIEWER, strongModel);
              const escalatedRaw = await callAI(aiKey.key, strongReviewerWithOverlays, reviewPromptMessages, {
                maxTokens: 512,
                timeout: 45000,
                model: strongModel,
                provider: aiKey.provider,
                log: { ...reviewLogCtx, feature: "self-review" as const },
              });

              const escalatedParsed = JSON.parse(cleanJSON(escalatedRaw));
              selfReview = {
                score: isFinite(Number(escalatedParsed.score)) ? Math.max(0, Math.min(100, Number(escalatedParsed.score))) : selfReview.score,
                concerns: Array.isArray(escalatedParsed.concerns) ? escalatedParsed.concerns : selfReview.concerns,
                recommendation: ["approve", "flag", "reject"].includes(escalatedParsed.recommendation) ? escalatedParsed.recommendation : selfReview.recommendation,
              };
            }
          } catch {
            // Escalation failed — keep cheap model result (already have a score)
          }
        }
      } catch {
        selfReview = { score: 0, concerns: ["Self-review could not be completed — AI call failed"], recommendation: "reject" };
      }

      await updateSession(sessionId, { selfReviewResult: selfReview });
      emit("self_review", selfReview);

      const reviewIcon = selfReview.score >= 80 ? "✅" : selfReview.score >= 50 ? "⚠️" : "❌";
      steps = await resolveStep(sessionId, steps,
        selfReview.recommendation === "reject" ? "failed" : "completed",
        `${reviewIcon} Self-review: ${selfReview.score}/100 — ${selfReview.recommendation}${selfReview.concerns.length > 0 ? ` (${selfReview.concerns.length} concern${selfReview.concerns.length > 1 ? "s" : ""})` : ""}`,
        emit);

      if (selfReview.recommendation === "reject" && attempt >= session.maxAttempts) {
        recordFailedFix({ projectId: session.projectId, errorFingerprint: alertFingerprint, fixSummary: fix.explanation?.slice(0, 500) ?? "fix generation", failureReason: `Self-review rejected (${selfReview.score}/100): ${selfReview.concerns.join("; ")}`, filesTouched: fix.files.map((f) => f.path) }).catch((e) => console.error("[remediate] recordFailedFix failed:", e));
        await fail(sessionId, emit,
          `Self-review rejected the fix (score: ${selfReview.score}/100).\n\nConcerns:\n${selfReview.concerns.map((c) => `• ${c}`).join("\n")}`
        );
        // Escalate: self-review rejected
        try {
          await triggerEscalation({
            alertId: alert.id,
            projectId: session.projectId,
            reason: "self_review_rejected",
            diagnosis: diagnosis.diagnosis,
            confidence: diagnosis.confidence,
            attempts: attempt,
            maxAttempts: session.maxAttempts,
            selfReviewScore: selfReview.score,
            selfReviewConcerns: selfReview.concerns,
          });
        } catch (e) { log.warn("escalation_self_review_failed", { error: e instanceof Error ? e.message : String(e) }); }
        return;
      }

      // ── PUSH + WAIT CI (with Fase 4 Part C flake-retry wrapper) ─────────
      // When pre-push (Fase 4 Part A) verified the fix green AND webhook
      // mode is on, a GitHub CI failure is likely flake (env-specific data,
      // network hiccup, runner caching) — re-push the same fix up to 3
      // times with 30s/2m/5m backoff before falling through to the
      // existing regenerate path. Only active when BOTH flags are on AND
      // the worker reported prepushPassed=true — a missing prepush signal
      // cannot distinguish flake from genuinely broken code.
      const effectiveBranch = managedAgentPushed && managedBranch
        ? managedBranch
        : branchName;
      let ciFlakeAttempts = 0;
      let headSha = "";
      let ciResult: Awaited<ReturnType<typeof gh.getCheckRunsStatus>> = null!;

      ciFlakeLoop: while (true) {
        const isFlakeRetry = ciFlakeAttempts > 0;

        // ── PUSH ─────────────────────────────────────────────────────────
        // On a flake retry we always push from our side even if the
        // managed agent pushed initially — we need a fresh commit to
        // re-trigger CI and the agent is no longer in the loop.
        if (managedAgentPushed && !isFlakeRetry) {
          await updateSession(sessionId, { status: "pushing", branch: effectiveBranch });
          steps = await pushStep(sessionId, steps,
            makeStep("push", `Managed Agent already pushed to ${effectiveBranch}`), emit);
          steps = await resolveStep(sessionId, steps, "completed",
            `Using Managed Agent branch ${effectiveBranch}`, emit);
        } else {
          await updateSession(sessionId, { status: "pushing", branch: effectiveBranch });
          emit("status", { status: "pushing" });

          steps = await pushStep(sessionId, steps,
            makeStep("push", isFlakeRetry
              ? `Re-pushing fix (CI flake retry ${ciFlakeAttempts}/3)...`
              : `Pushing fix to branch ${effectiveBranch}...`), emit);

          try {
            // createBranch only on the very first push — flake retries +
            // subsequent full attempts both reuse the branch that already
            // exists on GitHub.
            if (attempt === 1 && !isFlakeRetry) {
              await gh.createBranch(token, owner, repo, effectiveBranch, baseSha);
            }
            const commitMessage = isFlakeRetry
              ? `ci: retry ${ciFlakeAttempts}/3 (flake after green pre-push)\n\nPre-push passed locally; GitHub CI flaked. Re-triggering CI. Fix unchanged from attempt ${attempt}.`
              : `fix: ${alert.title.slice(0, 60)}\n\nAutomated fix by Inari AI (attempt ${attempt})`;
            const commitSha = await gh.commitFiles(
              token, owner, repo, effectiveBranch, commitMessage, fix.files
            );
            steps = await resolveStep(sessionId, steps, "completed",
              `Pushed commit ${commitSha.slice(0, 7)} to ${effectiveBranch}`, emit);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Push failed";
            steps = await resolveStep(sessionId, steps, "failed", msg, emit);
            if (msg.includes("403") || msg.includes("404")) {
              await fail(sessionId, emit,
                "GitHub token lacks write permissions. The token needs 'contents: write' scope to push fixes.");
              return;
            }
            await fail(sessionId, emit, msg);
            return;
          }
        } // end else (our push)

        // ── WAIT FOR CI ─────────────────────────────────────────────────
        await updateSession(sessionId, { status: "awaiting_ci" });
        emit("status", { status: "awaiting_ci" });

        steps = await pushStep(sessionId, steps,
          makeStep("await_ci", isFlakeRetry
            ? `Waiting for CI to re-run (flake retry ${ciFlakeAttempts}/3)...`
            : "Waiting for CI checks to run..."), emit);

        headSha = await gh.getBranchSha(token, owner, repo, effectiveBranch);

        // Fase 4 — webhook-driven CI monitoring. When CI_WEBHOOK_MODE=true,
        // register the sha→session mapping so the webhook handler can route
        // check_run.completed back to this session via Redis pub/sub. The
        // wait loop below uses waitForCiWebhook() instead of sleep() for
        // faster wake-up (sub-second vs 15s). Failure to register is
        // non-fatal — the loop falls back to plain polling.
        const ciWebhookOn = isCiWebhookEnabled();
        if (ciWebhookOn) {
          await registerCiSession(sessionId, headSha);
        }

        // Give GitHub a moment to register the push and start checks
        await sleep(10_000);

        // Fase 4 — webhooks are reliable enough to justify a longer overall
        // cap (10 min vs 5). In polling-only mode the 5-min cap stays in
        // place so /admin behavior and MTTR numbers don't shift.
        const maxWait = ciWebhookOn ? 10 * 60 * 1000 : 5 * 60 * 1000;
        const maxWaitLabel = ciWebhookOn ? "10 min" : "5 min";
        const startTime = Date.now();

        try {
          while (true) {
            ciResult = await gh.getCheckRunsStatus(token, owner, repo, headSha);

            if (ciResult.status === "success" || ciResult.status === "failure") break;

            if (Date.now() - startTime > maxWait) {
              if (ciResult.details.length === 0) {
                // No CI configured — create draft PR instead of auto-merging untested code
                steps = await resolveStep(sessionId, steps, "completed",
                  `No CI checks detected after ${maxWaitLabel} — creating draft PR for manual review`, emit);
                ciResult = { status: "failure", details: [] };
              }
              break;
            }

            // Notify the user we're still waiting
            emit("ci_poll", {
              elapsed: Math.round((Date.now() - startTime) / 1000),
              checks: ciResult.details.length,
              running: ciResult.details.filter((d) => d.status !== "completed").length,
              webhookMode: ciWebhookOn,
              flakeAttempt: ciFlakeAttempts,
            });

            if (ciWebhookOn) {
              // Cap the wake at 15s so we still get a periodic re-check even
              // when the webhook never fires (CI disabled, webhook misrouted,
              // GitHub outage). On "unavailable" — Redis down — fall back to a
              // plain sleep so the session doesn't burn CPU in a tight loop.
              const wait = await waitForCiWebhook(sessionId, 15_000);
              if (wait.result === "unavailable") {
                await sleep(15_000);
              }
            } else {
              await sleep(15_000);
            }
          }
        } finally {
          // Always clean up the sha→session mapping so a late webhook for a
          // past remediation doesn't ping a dead channel.
          if (ciWebhookOn) {
            await unregisterCiSession(headSha);
          }
        }

        // ── PART C: Intelligent CI retry ─────────────────────────────────
        // A CI failure after a green local pre-push is almost always flake
        // (env-specific data, network hiccup, runner caching). Re-push the
        // same fix up to 3 times with 30s / 2m / 5m backoff. Decision
        // lives in ci-retry.ts so the policy is unit-testable without
        // mocking the whole pipeline.
        const partCEligible = shouldRetryCiFlake({
          ciStatus: ciResult.status,
          prepushEnabled: process.env.PREPUSH_TESTS_ENABLED === "true",
          ciWebhookEnabled: isCiWebhookEnabled(),
          prepushPassed,
          flakeAttempts: ciFlakeAttempts,
          fileCount: fix.files.length,
        });
        if (!partCEligible) break ciFlakeLoop;

        const flakeBackoffMs = ciFlakeBackoffMs(ciFlakeAttempts);
        ciFlakeAttempts++;
        emit("ci_flake_retry", {
          attempt: ciFlakeAttempts,
          of: 3,
          backoffSec: Math.round(flakeBackoffMs / 1000),
        });
        steps = await pushStep(sessionId, steps,
          makeStep(
            "ci_flake_retry",
            `CI flake suspected (pre-push was green). Waiting ${Math.round(flakeBackoffMs / 1000)}s before retry ${ciFlakeAttempts}/3...`,
            "completed",
          ),
          emit,
        );
        await sleep(flakeBackoffMs);
      } // end ciFlakeLoop

      // ── CI RESULT ──────────────────────────────────────────────────────
      if (ciResult!.status === "success") {
        const checkCount = ciResult!.details.length;
        steps = await resolveStep(sessionId, steps, "completed",
          checkCount > 0
            ? `CI passed! (${checkCount} check${checkCount > 1 ? "s" : ""})`
            : "No CI configured — code pushed successfully", emit);

        // ── AUTO-CONTRIBUTE PATTERN (Fix Replay) ─────────────────────
        try {
          const category = alert.sourceIntegrations.includes("sentry") ? "runtime_error"
            : alert.sourceIntegrations.includes("vercel") ? "build_error"
            : alert.sourceIntegrations.includes("github") ? "ci_error"
            : alert.sourceIntegrations.includes("datadog") ? "infrastructure"
            : "unknown";
          const ctxSummary = [
            remediationContext.sentryStackTrace?.slice(0, 500),
            remediationContext.githubCILogs?.slice(0, 500),
            remediationContext.vercelBuildLogs?.slice(0, 500),
          ].filter(Boolean).join("\n---\n") || undefined;

          await autoContributePattern({
            fingerprint: alertFingerprint,
            alertTitle: alert.title,
            category,
            fixApproach: fix.explanation,
            fixDescription: diagnosis.diagnosis,
            filesChanged: fix.files.map((f) => f.path),
            confidence: diagnosis.confidence,
            contextSummary: ctxSummary,
          });
        } catch (e) { log.warn("auto_contribute_pattern_failed", { error: e instanceof Error ? e.message : String(e) }); }

        // ── SUBSTRATE SIMULATE GATE ────────────────────────────────────
        let simulateRiskScore: number | null = null;
        try {
          // Prefer recording linked to this specific alert, fall back to latest project recording
          let latestRecording = await db
            .select({ events: substrateRecordings.events, context: substrateRecordings.context })
            .from(substrateRecordings)
            .where(eq(substrateRecordings.alertId, session.alertId))
            .orderBy(desc(substrateRecordings.createdAt))
            .limit(1);
          if (latestRecording.length === 0) {
            latestRecording = await db
              .select({ events: substrateRecordings.events, context: substrateRecordings.context })
              .from(substrateRecordings)
              .where(eq(substrateRecordings.projectId, session.projectId))
              .orderBy(desc(substrateRecordings.createdAt))
              .limit(1);
          }

          if (latestRecording.length > 0 && latestRecording[0].events) {
            // We have a Substrate recording — the AI can compare the fix's expected behavior
            // against the recorded I/O trace. Score based on how many events the fix touches.
            const recordedEvents = latestRecording[0].events as { kind: { type: string } }[];
            const affectedFiles = fix.files.map((f) => f.path.toLowerCase());

            // Simple heuristic: if fix touches files that appear in DB queries or HTTP requests
            // from the recording, score higher risk.
            let touchedSurfaces = 0;
            for (const event of recordedEvents) {
              if (event.kind?.type === "db_query" || event.kind?.type === "http_request") {
                touchedSurfaces++;
              }
            }

            const exceptionCount = recordedEvents.filter(
              (e) => e.kind?.type === "exception"
            ).length;

            // Risk score: exceptions heavily weighted, touched surfaces add risk
            simulateRiskScore = Math.min(
              100,
              exceptionCount * 30 + Math.min(touchedSurfaces * 2, 30) + (affectedFiles.length > 3 ? 20 : 0)
            );

            emit("simulate", {
              status: "completed",
              riskScore: simulateRiskScore,
              recordedEvents: recordedEvents.length,
              exceptionCount,
              touchedSurfaces,
            });
          }
        } catch {
          // Non-blocking — simulate is optional
        }

        // ── SUBSTRATE REPLAY VERIFICATION ─────────────────────────────
        let replayResult: { passed: boolean; riskScore: number; analysis: string; replayContextUsed: boolean } | null = null;
        try {
          const { analyzeReplay } = await import("./substrate-replay");
          steps = await pushStep(sessionId, steps,
            makeStep("substrate_replay", "Analyzing Substrate I/O recording against fix..."), emit);

          // If this remediation was triggered from a Replay V2 session, its
          // sessionId is stored in session.context — pass it through so the
          // analyst can weigh the frontend user journey alongside raw I/O.
          const ctx = session.context as { replaySessionId?: string } | null;
          const replaySessionId = typeof ctx?.replaySessionId === "string" ? ctx.replaySessionId : undefined;

          const replay = await analyzeReplay(
            session.projectId, alert.id,
            diagnosis.diagnosis, fix.files,
            aiKey.key, aiKey.provider, remModel,
            {
              userId: session.userId,
              remediationSessionId: session.id,
              isPlatformKey: aiKey.isPlatformKey,
            },
            replaySessionId,
          );

          if (replay) {
            replayResult = {
              passed: replay.passed,
              riskScore: replay.riskScore,
              analysis: replay.analysis,
              replayContextUsed: !!replay.replayContextUsed,
            };
            emit("substrate_replay", {
              status: "completed",
              passed: replay.passed,
              confidence: replay.confidence,
              riskScore: replay.riskScore,
              analysis: replay.analysis,
              replayedEvents: replay.replayedEvents,
              mode: replay.mode,
              replayContextUsed: replay.replayContextUsed,
            });
            steps = await resolveStep(sessionId, steps,
              replay.passed ? "completed" : "failed",
              `Substrate replay: ${replay.analysis} (risk ${replay.riskScore}/100)`, emit);
          } else {
            steps = await resolveStep(sessionId, steps, "completed",
              "No Substrate recording available — replay skipped", emit);
          }
        } catch {
          steps = await resolveStep(sessionId, steps, "completed",
            "Substrate replay skipped (non-blocking)", emit);
        }

        // ── STAGING VERIFICATION ─────────────────────────────────────
        let e2eStagingPassed: boolean | null = null;

        // Primary: InariWatch Staging Server (ephemeral Docker container + Playwright bot)
        const stagingServerConfigured = !!process.env.STAGING_SERVER_URL;
        if (stagingServerConfigured) {
          try {
            const {
              deployStagingEnvironment, waitForStagingReady,
              verifyStagingWithBot, destroyStagingEnvironment, extractReplayEvents, extractUIReplayActions,
            } = await import("./staging-deploy");

            const deployId = `fix-${sessionId.slice(0, 8)}`;

            steps = await pushStep(sessionId, steps,
              makeStep("staging_deploy", "Deploying to staging environment..."), emit);

            // Deploy
            // Detect framework from files read during diagnosis
            const hasNext = fileContents.some((f: { path: string }) => f.path.includes("next.config") || f.path.includes("app/"));
            const hasExpress = fileContents.some((f: { content: string }) => f.content?.includes("express"));

            // Load project staging env vars (encrypted in DB, decrypted here for the container)
            let stagingEnvVars: Record<string, string> = {};
            try {
              const { getDecryptedStagingEnvVars } = await import("@/app/(dashboard)/projects/[slug]/staging-env-actions");
              stagingEnvVars = await getDecryptedStagingEnvVars(session.projectId);
            } catch { /* no staging env vars configured */ }

            const hasStagingDb = !!stagingEnvVars.DATABASE_URL;

            const deploy = await deployStagingEnvironment({
              deployId,
              repoUrl: `https://github.com/${fullRepo}.git`,
              branch: branchName,
              githubToken: token,
              projectId: session.projectId,
              framework: hasNext ? "nextjs" : hasExpress ? "express" : undefined,
              needsPostgres: !hasStagingDb, // Skip sidecar if user provides their own DB
              envVars: stagingEnvVars,
              ttlSeconds: 300,
            });
            // Save staging ID for orphan cleanup if we crash
            await saveCheckpoint(sessionId, "staging", undefined, deployId);
            emit("staging_deploy", { status: "deploying", url: deploy.url, id: deployId });

            try {
              // Wait for running
              steps = await resolveStep(sessionId, steps, "completed",
                `Staging deploying: ${deploy.url}`, emit);

              steps = await pushStep(sessionId, steps,
                makeStep("staging_wait", "Waiting for staging to be ready..."), emit);

              const ready = await waitForStagingReady(deployId, 180_000);
              emit("staging_deploy", { status: "running", url: ready.url, id: deployId });

              steps = await resolveStep(sessionId, steps, "completed",
                `Staging ready: ${ready.url}`, emit);

              // Verify with Playwright bot
              steps = await pushStep(sessionId, steps,
                makeStep("staging_verify", "Running browser verification bot..."), emit);
              emit("staging_deploy", { status: "verifying", url: ready.url, id: deployId });

              // Extract replay events from Substrate recording (HTTP + UI)
              let replayEvents: { type: string; method: string; path: string; body?: unknown; expectedStatus?: number }[] | undefined;
              let uiActions: { type: string; selector?: string; value?: string; url?: string; timestamp: number }[] | undefined;
              try {
                // Prefer recording linked to this alert, fall back to latest project recording
                let [rec] = await db.select({ events: substrateRecordings.events, uiEvents: substrateRecordings.uiEvents })
                  .from(substrateRecordings)
                  .where(eq(substrateRecordings.alertId, session.alertId))
                  .orderBy(desc(substrateRecordings.createdAt))
                  .limit(1);
                if (!rec) {
                  [rec] = await db.select({ events: substrateRecordings.events, uiEvents: substrateRecordings.uiEvents })
                    .from(substrateRecordings)
                    .where(eq(substrateRecordings.projectId, session.projectId))
                    .orderBy(desc(substrateRecordings.createdAt))
                    .limit(1);
                }
                if (rec?.events) {
                  replayEvents = extractReplayEvents(rec as { events: unknown[] });
                }
                if (rec?.uiEvents) {
                  uiActions = extractUIReplayActions(rec.uiEvents as unknown[]);
                }
              } catch { /* non-blocking */ }

              // UI actions take priority over HTTP-only replay
              const verification = await verifyStagingWithBot(deployId, replayEvents, uiActions);
              e2eStagingPassed = verification.passed;

              // AI Visual Analysis — send before/after screenshots to user's BYOK AI
              const finalScreenshot = verification.screenshots?.[verification.screenshots.length - 1];
              if (finalScreenshot && aiKey) {
                try {
                  const { callAIVision } = await import("./client");

                  // Try to extract "before" screenshot from rrweb recording
                  let beforeScreenshot: string | undefined;
                  try {
                    const [recSnap] = await db.select({ uiEvents: substrateRecordings.uiEvents })
                      .from(substrateRecordings)
                      .where(eq(substrateRecordings.alertId, session.alertId))
                      .orderBy(desc(substrateRecordings.createdAt))
                      .limit(1);
                    if (recSnap?.uiEvents) {
                      const events = recSnap.uiEvents as { type: string; data?: { source?: string }; screenshot?: string }[];
                      // rrweb full snapshot or last screenshot event
                      const snap = [...events].reverse().find((e) => e.screenshot || (e.type === "snapshot" && e.data?.source));
                      if (snap?.screenshot) beforeScreenshot = snap.screenshot;
                    }
                  } catch { /* before screenshot not available — ok */ }

                  const hasBefore = !!beforeScreenshot;
                  const prompt = hasBefore
                    ? `Compare these screenshots. BEFORE shows the broken state (when the error "${alert.title}" occurred). AFTER shows the app after the fix was applied.

Did the fix IMPROVE the page? Check:
1. If BEFORE was broken and AFTER looks correct → passed: true
2. If BEFORE was broken and AFTER looks the same or worse → passed: false
3. If AFTER has NEW visual issues not present in BEFORE → passed: false
4. Blank pages, error messages, broken layouts, missing content

Respond in JSON: {"passed": true/false, "improved": true/false, "issues": "description or empty", "beforeState": "brief description", "afterState": "brief description"}`
                    : `This is a screenshot of the app after applying a fix for: "${alert.title}".
Does the page look correct? Check for blank pages, error messages, broken layouts, missing content.

Respond in JSON: {"passed": true/false, "issues": "description of issues or empty string"}`;

                  const visualResponse = await callAIVision(
                    aiKey.key,
                    "You are a QA engineer reviewing screenshots of a web application. Analyze for visual regressions introduced by an automated fix.",
                    {
                      role: "user",
                      text: prompt,
                      imageBase64: finalScreenshot,
                      beforeImageBase64: beforeScreenshot,
                    },
                    {
                      maxTokens: 300,
                      provider: aiKey.provider,
                      log: {
                        userId: session.userId,
                        projectId: session.projectId,
                        alertId: session.alertId,
                        remediationSessionId: sessionId,
                        feature: "remediation",
                        isPlatformKey: aiKey.isPlatformKey,
                      },
                    }
                  );
                  try {
                    const parsed = JSON.parse(visualResponse.replace(/```json\n?|\n?```/g, "").trim());
                    if (parsed.passed === false) {
                      // Only override bot result when we have a "before" screenshot to compare
                      // Without a reference, the AI can't distinguish "blank page = bug" from "no data = normal"
                      if (hasBefore) {
                        e2eStagingPassed = false;
                      }
                      verification.aiVisual = { passed: false, issues: parsed.issues || "AI detected visual issues" };
                    } else {
                      verification.aiVisual = { passed: true, issues: "" };
                    }
                  } catch { /* AI response not parseable — keep bot result */ }
                } catch (e) {
                  log.warn("ai_visual_analysis_failed", { error: e instanceof Error ? e.message : String(e) });
                }
              }

              emit("staging_deploy", {
                status: e2eStagingPassed ? "passed" : "failed",
                url: ready.url,
                id: deployId,
                results: verification.results,
                consoleErrors: verification.consoleErrors,
                durationMs: verification.durationMs,
                aiVisual: verification.aiVisual,
              });

              const resultSummary = verification.results
                .map((r) => `${r.passed ? "✓" : "✗"} ${r.statusCode} (${r.durationMs}ms)`)
                .join(", ");
              const visualNote = verification.aiVisual?.passed === false
                ? ` | AI visual: ${verification.aiVisual.issues.slice(0, 80)}`
                : "";

              steps = await resolveStep(sessionId, steps,
                e2eStagingPassed ? "completed" : "failed",
                e2eStagingPassed
                  ? `Staging verified: ${resultSummary}${visualNote}`
                  : `Staging failed: ${resultSummary}${visualNote}`, emit);
            } finally {
              // Guarantee cleanup even if verification throws
              destroyStagingEnvironment(deployId).catch((e) => log.warn("staging_cleanup_failed", { deployId, error: e instanceof Error ? e.message : String(e) }));
            }

          } catch (e) {
            const stagingError = e instanceof Error ? e.message : String(e);
            const isBuildFailure = stagingError.includes("build failed") || stagingError.includes("failed to start");

            if (isBuildFailure && attempt < session.maxAttempts) {
              // Staging build failed — retry with the build error as context
              log.warn("staging_build_failed_retrying", { error: stagingError, attempt });
              steps = await resolveStep(sessionId, steps, "failed",
                `Staging build failed — retrying with build error context...`, emit);
              previousAttempt = { files: fix.files, ciError: `Staging build error:\n${stagingError}` };
              attempt++;
              continue; // Re-enter the while loop → regenerate fix
            }

            log.warn("staging_server_failed", { error: stagingError });
            steps = await resolveStep(sessionId, steps, "completed",
              "Staging server unavailable — falling back to E2E", emit);
            // Fall through to GitHub Actions E2E fallback below
          }
        }

        // Fallback: GitHub Actions E2E (when staging server not configured or failed)
        if (e2eStagingPassed === null) {
          try {
            const { detectE2EConfig, pushE2EWorkflow, waitForE2EResult } = await import("./staging-e2e");

            steps = await pushStep(sessionId, steps,
              makeStep("e2e_staging", "Detecting E2E test configuration..."), emit);

            const e2eConfig = await detectE2EConfig(token, owner, repo, defaultBranch);

            if (e2eConfig) {
              emit("e2e_staging", { status: "detected", framework: e2eConfig.framework, testCommand: e2eConfig.testCommand });

              const pushed = await pushE2EWorkflow(token, owner, repo, branchName, e2eConfig);

              if (pushed) {
                steps = await resolveStep(sessionId, steps, "completed",
                  `E2E staging: ${e2eConfig.framework} detected, running ${e2eConfig.testCommand}...`, emit);

                steps = await pushStep(sessionId, steps,
                  makeStep("e2e_wait", "Waiting for E2E staging results..."), emit);

                const headSha = await gh.getBranchSha(token, owner, repo, effectiveBranch);
                const e2eResult = await waitForE2EResult(token, owner, repo, headSha);

                if (e2eResult) {
                  e2eStagingPassed = e2eResult.passed;
                  emit("e2e_staging", { status: "completed", passed: e2eResult.passed, duration: e2eResult.duration });
                  steps = await resolveStep(sessionId, steps,
                    e2eResult.passed ? "completed" : "failed",
                    e2eResult.passed
                      ? `E2E staging passed (${e2eResult.duration}s)`
                      : `E2E staging failed: ${e2eResult.logs}`, emit);
                } else {
                  steps = await resolveStep(sessionId, steps, "completed",
                    "E2E staging timed out (non-blocking)", emit);
                }
              } else {
                steps = await resolveStep(sessionId, steps, "completed",
                  "Could not push E2E workflow — skipped", emit);
              }
            } else {
              steps = await resolveStep(sessionId, steps, "completed",
                "No E2E test framework detected — staging skipped", emit);
            }
          } catch {
            steps = await resolveStep(sessionId, steps, "completed",
              "E2E staging skipped (non-blocking)", emit);
          }
        }

        // ── EVALUATE AUTO-MERGE GATES ──────────────────────────────────
        const baseConfig = (proj?.autoMergeConfig as AutoMergeConfig | null) ?? DEFAULT_AUTO_MERGE_CONFIG;
        const totalLinesChanged = fix.files.reduce((sum, f) => sum + f.content.split("\n").length, 0);

        // Apply trust level — tightens thresholds based on project's track record
        const { getProjectTrustLevel, applyTrustLevel } = await import("./trust-level");
        const trackRecord = await getProjectTrustLevel(session.projectId);
        const autoMergeConfig = {
          ...baseConfig,
          ...applyTrustLevel(baseConfig, trackRecord.trustLevel),
        };
        emit("trust_level", { name: trackRecord.trustLevel.name, level: trackRecord.trustLevel.level, total: trackRecord.total, successRate: trackRecord.successRate, fixesToNextLevel: trackRecord.fixesToNextLevel });

        // Extract EAP verification from gathered context
        const eapChainVerified = remediationContext.eapReceipt?.verified ?? null;

        // Compute circuit breaker bypasses for this project
        const bypassableGates = ["substrate_simulate", "eap_chain_verified", "prediction_safe", "substrate_replay", "e2e_staging"];
        const circuitBreakerBypassed = new Set<string>();
        for (const g of bypassableGates) {
          const { bypass } = await shouldBypassGate(session.projectId, g);
          if (bypass) circuitBreakerBypassed.add(g);
        }

        const gateResult = evaluateAutoMergeGates({
          config: autoMergeConfig,
          confidenceScore: diagnosis.confidence,
          selfReviewResult: selfReview,
          linesChanged: totalLinesChanged,
          ciPassed: true,
          simulateRiskScore,
          substrateReplayPassed: replayResult?.passed ?? null,
          substrateReplayUsedFrontendContext: replayResult?.replayContextUsed ?? null,
          e2eStagingPassed,
          eapChainVerified,
          securityScanHighCount: securityHighCount,
          containerVerified: containerVerified || null,
          circuitBreakerBypassed,
        });

        // Record gate telemetry for circuit breaker + dashboard
        for (const gate of gateResult.gates) {
          recordGateResult(session.projectId, gate.name, gate.passed, gate.passed ? undefined : gate.reason)
            .catch(() => {}); // non-blocking
        }

        emit("gates", { gates: gateResult.gates, strategy: gateResult.strategy });

        // Store simulate score in session for tracking.
        if (simulateRiskScore != null) {
          await updateSession(sessionId, { simulateRiskScore });
        }

        // Tri-color tier from the canonical helper (PR #7).
        const { confidenceEmoji: confEmoji, confidenceTier, confidenceLabel: confLabel } =
          await import("./confidence");
        const confidenceEmoji = confEmoji(confidenceTier(diagnosis.confidence));
        const confidenceLine = confLabel(diagnosis.confidence);
        const isAutoMerge = gateResult.strategy === "auto_merge";

        // ── CREATE PR ────────────────────────────────────────────────────
        await updateSession(sessionId, { status: "proposing", mergeStrategy: gateResult.strategy, proposedAt: new Date() });
        emit("status", { status: "proposing" });

        steps = await pushStep(sessionId, steps,
          makeStep("create_pr", isAutoMerge ? "Creating PR and auto-merging..." : "Creating draft PR for review..."), emit);

        const prBody = [
          `## 🤖 Automated fix by Inari AI`,
          ``,
          isAutoMerge
            ? `> ✅ **Auto-merged.** All safety gates passed. Post-merge monitoring is active.`
            : `> **⚠️ This is a draft PR.** Review all changes carefully before marking it ready to merge.`,
          ``,
          `| Field | Value |`,
          `|---|---|`,
          `| **Alert** | ${alert.title} |`,
          `| **Severity** | ${alert.severity} |`,
          `| **Confidence** | ${confidenceLine} |`,
          `| **Self-review** | ${selfReview ? `${selfReview.score}/100 (${selfReview.recommendation})` : "N/A"} |`,
          `| **Substrate simulate** | ${simulateRiskScore != null ? `${simulateRiskScore}/100 risk` : "No recording"} |`,
          `| **Strategy** | ${isAutoMerge ? "Auto-merged" : "Draft PR"} |`,
          ``,
          `### Diagnosis`,
          diagnosis.diagnosis,
          ``,
          `### What was changed`,
          fix.explanation,
          ``,
          `### Files modified`,
          ...fix.files.map((f) => `- \`${f.path}\``),
          ``,
          attempt > 1
            ? `> ♻️ This fix was verified after ${attempt} CI attempts. Previous approaches failed.\n`
            : "",
          ...(isAutoMerge ? [
            `### Safety gates`,
            ...gateResult.gates.map((g) => `- ${g.passed ? "✅" : "❌"} ${g.reason}`),
          ] : [
            `### Before merging`,
            `- [ ] Review each file change in the diff`,
            `- [ ] Confirm CI passes on this branch`,
            `- [ ] Test manually if the change affects critical paths`,
            ``,
            `### Gate results (why not auto-merged)`,
            ...gateResult.gates.map((g) => `- ${g.passed ? "✅" : "❌"} ${g.reason}`),
          ]),
          ``,
          ``,
          (() => { try { return `**Context sources:** ${getServiceStatusSummary()}`; } catch { return ""; } })(),
          ``,
          `---`,
          `*Generated by [Inari AI](https://inariwatch.com)*`,
        ].filter(Boolean).join("\n");

        try {
          const pr = await gh.createPR(
            token, owner, repo,
            `fix: ${alert.title.slice(0, 60)}`,
            prBody, effectiveBranch, defaultBranch,
            !isAutoMerge // draft = true if NOT auto-merge
          );
          await updateSession(sessionId, { prUrl: pr.url, prNumber: pr.number });

          // Update status page incident → fixing
          try {
            await updateIncidentStatus({
              alertId: alert.id,
              remediationSessionId: sessionId,
              status: isAutoMerge ? "fixing" : "identified",
              message: isAutoMerge
                ? `A fix has been deployed and is being verified by CI.`
                : `A draft fix (PR #${pr.number}) has been created for human review.`,
            });
          } catch (e) { log.warn("incident_status_update_failed", { phase: "pr_created", error: e instanceof Error ? e.message : String(e) }); }

          if (isAutoMerge) {
            // Auto-merge the PR
            steps = await resolveStep(sessionId, steps, "completed", `PR #${pr.number} created`, emit);

            steps = await pushStep(sessionId, steps,
              makeStep("auto_merge", "Auto-merging — all safety gates passed..."), emit);

            try {
              const mergeResult = await gh.mergePR(token, owner, repo, pr.number);
              const mergedSha = mergeResult.sha;
              steps = await resolveStep(sessionId, steps, "completed",
                `PR #${pr.number} auto-merged successfully`, emit);

              // Update status page → monitoring
              try {
                await updateIncidentStatus({
                  alertId: alert.id,
                  remediationSessionId: sessionId,
                  status: "monitoring",
                  message: `Fix merged successfully. Monitoring for regressions (10 min).`,
                });
              } catch (e) { log.warn("incident_status_update_failed", { phase: "monitoring", error: e instanceof Error ? e.message : String(e) }); }

              // VAR Q3 Phase 2 — submit EAP attestation receipt for this
              // remediation. Fire-and-forget: a failed submission must
              // NEVER fail the remediation itself. The remediation's
              // value is the merged fix; the EAP receipt is a downstream
              // audit artifact that can be retried later if needed.
              submitReceiptForRemediation(sessionId)
                .then((outcome) => {
                  if ("ok" in outcome && outcome.ok) {
                    emit("eap_receipt", { receiptId: outcome.receiptId, signed: outcome.signed });
                  }
                })
                .catch((err) => {
                  log.warn("eap_attestation_failed", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                });

              // Start post-merge monitoring if enabled
              if (autoMergeConfig.postMergeMonitor) {
                steps = await pushStep(sessionId, steps,
                  makeStep("monitoring", "Post-merge monitoring — watching for regressions (10 min)..."), emit);

                await startPostMergeMonitoring({
                  sessionId,
                  projectId: session.projectId,
                  mergedCommitSha: mergedSha,
                  alertTitle: alert.title,
                  repo: fullRepo,
                  defaultBranch,
                  ghToken: token,
                  emit,
                  fingerprint: alertFingerprint,
                });
                return; // post-merge monitor handles emit("done")
              } else {
                await updateSession(sessionId, { status: "completed" });
                // Record fix embedding for future replay
                try {
                  const { recordFixEmbedding } = await import("@/lib/code-intelligence/fix-replay");
                  if (aiKey.provider === "openai" || aiKey.provider === "deepseek") {
                    recordFixEmbedding(sessionId, aiKey.key).catch(() => {});
                  }
                } catch (e) { log.warn("fix_embedding_failed", { error: e instanceof Error ? e.message : String(e) }); }
                // Generate postmortem and resolve status page incident
                try {
                  await generatePostmortemInternal(alert.id);
                  const postmortemText = (await db.select({ pm: alerts.postmortem }).from(alerts).where(eq(alerts.id, alert.id)).limit(1))[0]?.pm;
                  await resolveStatusIncident({ remediationSessionId: sessionId, postmortem: postmortemText ?? undefined });
                } catch (e) { log.warn("postmortem_or_resolve_failed", { error: e instanceof Error ? e.message : String(e) }); }
                // Record calibration: AI was confident and the fix succeeded
                recordCalibrationPoint(session.projectId, rawConfidence, true).catch(() => {});
                emit("done", { status: "completed", prUrl: pr.url, prNumber: pr.number, autoMerged: true });
                return;
              }
            } catch (mergeErr) {
              const msg = mergeErr instanceof Error ? mergeErr.message : "Merge failed";
              steps = await resolveStep(sessionId, steps, "failed", `Auto-merge failed: ${msg}`, emit);
              // Fall through to show as draft PR
              steps = await pushStep(sessionId, steps,
                makeStep("fallback", `Falling back to draft PR — review and merge manually.`, "completed"), emit);
              emit("done", { status: "proposing", prUrl: pr.url, prNumber: pr.number });
              return;
            }
          }

          // Draft PR path
          steps = await resolveStep(sessionId, steps, "completed", `Draft PR #${pr.number} created`, emit);

          steps = await pushStep(sessionId, steps,
            makeStep("done", `Fix verified — CI passes. Review the draft PR on GitHub.`, "completed"), emit);

          emit("done", { status: "proposing", prUrl: pr.url, prNumber: pr.number });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to create PR";
          steps = await resolveStep(sessionId, steps, "failed", msg, emit);
          await fail(sessionId, emit, msg);
          return;
        }
      }

      // ── CI FAILED ──────────────────────────────────────────────────────
      const failedChecks = ciResult!.details
        .filter((d) => d.conclusion === "failure" || d.conclusion === "timed_out")
        .map((d) => d.name);

      steps = await resolveStep(sessionId, steps, "failed",
        `CI failed: ${failedChecks.join(", ") || "unknown check"}`, emit);

      if (attempt >= session.maxAttempts) {
        steps = await pushStep(sessionId, steps,
          makeStep("max_retries",
            `Tried ${attempt} different approaches but CI still fails. The branch "${branchName}" has the latest attempt — you can review and fix it manually.`,
            "failed"), emit);
        await updateSession(sessionId, { status: "failed", error: `CI still failing after ${attempt} attempts` });
        // Record failed fix for learning
        recordFailedFix({ projectId: session.projectId, errorFingerprint: alertFingerprint, fixSummary: fix.explanation?.slice(0, 500) ?? "fix generation", failureReason: `CI failure after ${attempt} attempts: ${failedChecks.join(", ")}`, filesTouched: fix.files.map((f) => f.path) }).catch(() => {});
        // Escalate: max retries exhausted
        try {
          await triggerEscalation({
            alertId: alert.id,
            projectId: session.projectId,
            reason: "max_retries_exhausted",
            diagnosis: diagnosis.diagnosis,
            confidence: diagnosis.confidence,
            attempts: attempt,
            maxAttempts: session.maxAttempts,
            ciError: failedChecks.join(", "),
            branch: branchName,
            filesChanged: fix.files.map((f) => f.path),
          });
        } catch (e) { log.warn("escalation_max_retries_failed", { error: e instanceof Error ? e.message : String(e) }); }
        emit("done", { status: "failed", error: `CI still failing after ${attempt} attempts`, branch: branchName });
        return;
      }

      // Communicate transparently
      steps = await pushStep(sessionId, steps,
        makeStep("retry",
          `Attempt ${attempt} didn't fix the issue. Analyzing the CI failure to try a different approach...`,
          "completed"), emit);

      // Read CI logs for context
      const ciLogs = await gh.getFailedCheckLogs(token, owner, repo, branchName);
      previousAttempt = { files: fix.files, ciError: ciLogs };
      attempt++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    await fail(sessionId, emit, msg);
  }
}

// ── Fix Replay: auto-contribute pattern after successful remediation ─────────

async function autoContributePattern(params: {
  fingerprint: string;
  alertTitle: string;
  category: string;
  fixApproach: string;
  fixDescription: string;
  filesChanged: string[];
  confidence: number;
  contextSummary?: string;
}) {
  // Upsert error pattern
  let [pattern] = await db
    .select()
    .from(errorPatterns)
    .where(eq(errorPatterns.fingerprint, params.fingerprint))
    .limit(1);

  if (pattern) {
    await db
      .update(errorPatterns)
      .set({ occurrenceCount: pattern.occurrenceCount + 1, lastSeenAt: new Date() })
      .where(eq(errorPatterns.id, pattern.id));
  } else {
    [pattern] = await db
      .insert(errorPatterns)
      .values({
        fingerprint: params.fingerprint,
        patternText: params.alertTitle.slice(0, 500),
        category: params.category,
        contextSummary: params.contextSummary?.slice(0, 2000),
      })
      .returning();
  }

  // Dedup: if a fix with the same approach already exists, increment success
  const existingFixes = await db
    .select()
    .from(communityFixes)
    .where(eq(communityFixes.patternId, pattern.id));

  const similar = existingFixes.find(
    (f) => f.fixApproach.toLowerCase() === params.fixApproach.toLowerCase()
  );

  if (similar) {
    await db
      .update(communityFixes)
      .set({
        successCount: similar.successCount + 1,
        totalApplications: similar.totalApplications + 1,
        avgConfidence: Math.round(
          (similar.avgConfidence * similar.totalApplications + params.confidence) /
          (similar.totalApplications + 1)
        ),
        updatedAt: new Date(),
      })
      .where(eq(communityFixes.id, similar.id));
  } else {
    await db.insert(communityFixes).values({
      patternId: pattern.id,
      fixApproach: params.fixApproach.slice(0, 1000),
      fixDescription: params.fixDescription.slice(0, 2000),
      filesChangedSummary: params.filesChanged.join(", "),
      avgConfidence: params.confidence,
      successCount: 1,
      totalApplications: 1,
    });
  }
}

async function fail(sessionId: string, emit: Emit, error: string) {
  // Release any file locks held by this session
  releaseFileLocks(sessionId).catch(() => {});
  await updateSession(sessionId, { status: "failed", error });
  emit("done", { status: "failed", error });
}
