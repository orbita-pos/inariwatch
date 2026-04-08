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
import { computeErrorFingerprint } from "./fingerprint";
import { getProjectOwnerAIKey } from "./get-key";
import { resolveModel } from "./models";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import { gatherRemediationContext } from "./context-gatherer";
import { evaluateAutoMergeGates, type SelfReviewResult } from "./auto-merge-gates";
import { startPostMergeMonitoring } from "./post-merge-monitor";
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

type Emit = (event: string, data: unknown) => void;

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

  // Compute and store error fingerprint for fix replay
  const alertFingerprint = computeErrorFingerprint(alert.title, alert.body);
  await updateSession(sessionId, { fingerprint: alertFingerprint });

  // Get AI key
  const aiKey = await getProjectOwnerAIKey(session.projectId);
  if (!aiKey) { await fail(sessionId, emit, "No AI key configured. Add one in Settings."); return; }
  if (aiKey.isPlatformKey) { await fail(sessionId, emit, "Code remediation requires your own AI key. Add one in Settings → AI analysis."); return; }

  // Find GitHub integration
  const integrations = await db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, session.projectId));
  const ghInteg = integrations.find((i) => i.service === "github");
  if (!ghInteg) { await fail(sessionId, emit, "No GitHub integration connected for this project."); return; }

  const config = decryptConfig(ghInteg.configEncrypted);
  const token = config.token as string;
  const owner = config.owner as string;
  if (!token || !owner) { await fail(sessionId, emit, "GitHub integration missing token or owner."); return; }

  // Detect repo name
  let extractedRepo = extractRepo(alert.title);
  
  // Try listing repos first to validate
  const repos = await gh.listOwnerRepos(token, owner);
  
  // Only use the extracted repo if it actually exists in GitHub
  let repo = (extractedRepo && repos.includes(extractedRepo)) ? extractedRepo : null;

  if (!repo) {
    if (repos.length === 1) {
      repo = repos[0];
    } else if (repos.length > 1) {
      // Heuristic 1: If user explicitly selected a repo in GitHub integration settings
      const alertConfig = config.alertConfig as Record<string, any> | undefined;
      const repoFilter = Array.isArray(alertConfig?.repoFilter) ? alertConfig.repoFilter : [];
      let mappedRepo = null;
      if (repoFilter.length === 1 && typeof repoFilter[0] === "string") {
        mappedRepo = repoFilter[0].split("/")[1];
      }
      
      if (mappedRepo && repos.includes(mappedRepo)) {
        repo = mappedRepo;
      } else {
        // Heuristic 2: look for repo name in alert body
        const bodyLower = alert.body.toLowerCase();
        repo = repos.find((r) => bodyLower.includes(r.toLowerCase())) ?? null;
      }
    }
  }

  if (!repo) { await fail(sessionId, emit, "Could not determine repository from alert. Please add the repo name in the integration config."); return; }

  const fullRepo = `${owner}/${repo}`;
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
      { title: alert.title, body: alert.body, sourceIntegrations: alert.sourceIntegrations },
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
      ], { maxTokens: 600, timeout: 45000, model: remModel, provider: aiKey.provider });
    } catch (err) {
      await fail(sessionId, emit, `Diagnosis failed: ${err instanceof Error ? err.message : "AI provider error"}`);
      return;
    }

    let diagnosis: { diagnosis: string; filesToRead: string[]; confidence: number };
    try {
      const parsed = JSON.parse(cleanJSON(diagRaw));
      // Normalize confidence to number (backward compat with old "high"/"medium"/"low")
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

    // ── READ PACKAGE.JSON (stack detection) ─────────────────────────────
    let projectDeps: string[] = [];
    let stackContext = "";
    try {
      const pkgRaw = await gh.getFileContent(token, owner, repo, "package.json", defaultBranch);
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        projectDeps = [
          ...Object.keys(pkg.dependencies ?? {}),
          ...Object.keys(pkg.devDependencies ?? {}),
        ];
        const { getStackInstructions } = await import("./prompts");
        stackContext = getStackInstructions(projectDeps);
        if (projectDeps.length > 0) {
          stackContext = `Dependencies: ${projectDeps.slice(0, 30).join(", ")}\n${stackContext}`;
        }
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

      // Try agentic loop on first attempt — AI explores the repo with tools
      // Works when user has Claude key OR platform has PLATFORM_ANTHROPIC_KEY
      const hasClaude = aiKey.provider === "claude" || !!process.env.PLATFORM_ANTHROPIC_KEY;
      const useAgentic = attempt === 1 && hasClaude && !previousAttempt;

      if (useAgentic) {
        steps = await pushStep(sessionId, steps,
          makeStep("generate_fix", "AI is exploring the codebase to understand and fix the bug..."), emit);

        try {
          const { runAgenticLoop } = await import("./agentic-loop");

          const errorContext = [
            `ERROR: ${alert.title}`,
            `SEVERITY: ${alert.severity}`,
            `STACK TRACE:\n${alert.body.slice(0, 3000)}`,
            remediationContext?.sentryStackTrace ? `\nSENTRY:\n${remediationContext.sentryStackTrace.slice(0, 2000)}` : "",
            remediationContext?.vercelBuildLogs ? `\nBUILD LOGS:\n${remediationContext.vercelBuildLogs.slice(0, 2000)}` : "",
            remediationContext?.githubCILogs ? `\nCI LOGS:\n${remediationContext.githubCILogs.slice(0, 2000)}` : "",
            remediationContext?.codebaseContext ? `\nCODEBASE PATTERNS:\n${remediationContext.codebaseContext.slice(0, 4000)}` : "",
          ].filter(Boolean).join("\n\n");

          // Use platform Anthropic key if available, otherwise user's BYOK key
          const { getPlatformAnthropicKey } = await import("./get-key");
          const platformClaude = getPlatformAnthropicKey();
          const agenticKey = platformClaude ?? aiKey;

          const agenticResult = await runAgenticLoop({
            apiKey: agenticKey.key,
            provider: "claude",
            exploreModel: "claude-haiku-4-5-20251001",  // Cheap for exploration
            fixModel: "claude-sonnet-4-6",               // Quality for fix generation
            systemPrompt: "",
            errorContext,
            token,
            owner,
            repo,
            defaultBranch,
            projectId: session.projectId,
            repoFiles: repoFiles.slice(0, 500),
            emit: (event: string, data: Record<string, unknown>) => emit(event, data),
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
          fixRaw = await callAIWithRetry(aiKey.key, SYSTEM_REMEDIATOR, [
            { role: "user", content: buildFixPrompt(diagnosis.diagnosis, fileContents, alert.body, previousAttempt, remediationContext?.codebaseContext, antiPatternCtx, stackContext) },
          ], { maxTokens: 4096, timeout: 60000, model: remModel, provider: aiKey.provider });
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

      if (!fix.files?.length) {
        await fail(sessionId, emit, "AI could not determine what code to change.");
        return;
      }

      // Validate file paths — reject dangerous or blocked files
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
        // Warn but continue with remaining safe files
        emit("warning", { message: `Skipped protected files: ${blockedFiles.join(", ")}` });
      }

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
        ], { maxTokens: 2048, timeout: 45000, model: remModel, provider: aiKey.provider });

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
      let securityHighCount: number | null = null;
      steps = await pushStep(sessionId, steps,
        makeStep("security_scan", "Running security scan on generated fix..."), emit);

      try {
        const { scanFiles, aiSecurityReview } = await import("./security-scan");
        const scanResult = scanFiles(fix.files);

        // AI security review — async, non-blocking enhancement
        try {
          const aiFindings = await aiSecurityReview(fix.files, callAI, aiKey.key);
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

      // ── SELF-REVIEW ────────────────────────────────────────────────────
      let selfReview: SelfReviewResult | null = null;
      steps = await pushStep(sessionId, steps,
        makeStep("self_review", "AI is reviewing the generated fix for correctness..."), emit);

      try {
        const reviewRaw = await callAI(aiKey.key, SYSTEM_REVIEWER, [
          { role: "user", content: buildSelfReviewPrompt(
            diagnosis.diagnosis, fileContents, fix.files, alert.body
          ) },
        ], { maxTokens: 1024, timeout: 45000, model: remModel, provider: aiKey.provider });

        const parsed = JSON.parse(cleanJSON(reviewRaw));
        selfReview = {
          score: isFinite(Number(parsed.score)) ? Math.max(0, Math.min(100, Number(parsed.score))) : 50,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
          recommendation: ["approve", "flag", "reject"].includes(parsed.recommendation) ? parsed.recommendation : "flag",
        };
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

      // ── PUSH ─────────────────────────────────────────────────────────────
      await updateSession(sessionId, { status: "pushing", branch: branchName });
      emit("status", { status: "pushing" });

      steps = await pushStep(sessionId, steps,
        makeStep("push", `Pushing fix to branch ${branchName}...`), emit);

      try {
        if (attempt === 1) {
          await gh.createBranch(token, owner, repo, branchName, baseSha);
        }
        const commitSha = await gh.commitFiles(
          token, owner, repo, branchName,
          `fix: ${alert.title.slice(0, 60)}\n\nAutomated fix by Inari AI (attempt ${attempt})`,
          fix.files
        );
        steps = await resolveStep(sessionId, steps, "completed",
          `Pushed commit ${commitSha.slice(0, 7)} to ${branchName}`, emit);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Push failed";
        steps = await resolveStep(sessionId, steps, "failed", msg, emit);
        // Check if it's a permissions issue
        if (msg.includes("403") || msg.includes("404")) {
          await fail(sessionId, emit,
            "GitHub token lacks write permissions. The token needs 'contents: write' scope to push fixes.");
          return;
        }
        await fail(sessionId, emit, msg);
        return;
      }

      // ── WAIT FOR CI ──────────────────────────────────────────────────────
      await updateSession(sessionId, { status: "awaiting_ci" });
      emit("status", { status: "awaiting_ci" });

      steps = await pushStep(sessionId, steps,
        makeStep("await_ci", "Waiting for CI checks to run..."), emit);

      const headSha = await gh.getBranchSha(token, owner, repo, branchName);

      // Give GitHub a moment to register the push and start checks
      await sleep(10_000);

      const maxWait = 5 * 60 * 1000; // 5 minutes
      const startTime = Date.now();
      let ciResult: Awaited<ReturnType<typeof gh.getCheckRunsStatus>>;

      while (true) {
        ciResult = await gh.getCheckRunsStatus(token, owner, repo, headSha);

        if (ciResult.status === "success" || ciResult.status === "failure") break;

        if (Date.now() - startTime > maxWait) {
          if (ciResult.details.length === 0) {
            // No CI configured — create draft PR instead of auto-merging untested code
            steps = await resolveStep(sessionId, steps, "completed",
              "No CI checks detected after 5 min — creating draft PR for manual review", emit);
            ciResult = { status: "failure", details: [] };
          }
          break;
        }

        // Notify the user we're still waiting
        emit("ci_poll", {
          elapsed: Math.round((Date.now() - startTime) / 1000),
          checks: ciResult.details.length,
          running: ciResult.details.filter((d) => d.status !== "completed").length,
        });

        await sleep(15_000);
      }

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
        let replayResult: { passed: boolean; riskScore: number; analysis: string } | null = null;
        try {
          const { analyzeReplay } = await import("./substrate-replay");
          steps = await pushStep(sessionId, steps,
            makeStep("substrate_replay", "Analyzing Substrate I/O recording against fix..."), emit);

          const replay = await analyzeReplay(
            session.projectId, alert.id,
            diagnosis.diagnosis, fix.files,
            aiKey.key, aiKey.provider, remModel
          );

          if (replay) {
            replayResult = { passed: replay.passed, riskScore: replay.riskScore, analysis: replay.analysis };
            emit("substrate_replay", {
              status: "completed",
              passed: replay.passed,
              confidence: replay.confidence,
              riskScore: replay.riskScore,
              analysis: replay.analysis,
              replayedEvents: replay.replayedEvents,
              mode: replay.mode,
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
                    { maxTokens: 300, provider: aiKey.provider }
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

                const headSha = await gh.getBranchSha(token, owner, repo, branchName);
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
          e2eStagingPassed,
          eapChainVerified,
          securityScanHighCount: securityHighCount,
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

        const confidenceEmoji = diagnosis.confidence >= 80 ? "🟢" : diagnosis.confidence >= 50 ? "🟡" : "🔴";
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
          `| **Confidence** | ${confidenceEmoji} ${diagnosis.confidence}% |`,
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
            prBody, branchName, defaultBranch,
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
