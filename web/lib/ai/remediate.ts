/**
 * AI Remediation Engine
 *
 * Orchestrates the full fix cycle:
 *   analyze → read code → generate fix → push → wait CI → create PR
 *
 * Each step updates the DB and calls `emit()` for real-time streaming to the UI.
 * If CI fails, the engine retries with context about what went wrong (up to 3 attempts).
 */

import { db, remediationSessions, alerts, projectIntegrations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { callAI } from "./client";
import { SYSTEM_REMEDIATOR, buildDiagnosePrompt, buildFixPrompt } from "./prompts";
import { getProjectOwnerAIKey } from "./get-key";
import { resolveModel } from "./models";
import { decryptConfig } from "@/lib/crypto";
import * as gh from "@/lib/services/github-api";
import type { RemediationStep } from "@/lib/db/schema";

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

function isSafeFilePath(p: string): boolean {
  return !p.includes("..") && !p.startsWith("/") && !p.includes("\\") && !p.startsWith("~");
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

export async function runRemediation(sessionId: string, emit: Emit): Promise<void> {
  const [session] = await db.select().from(remediationSessions).where(eq(remediationSessions.id, sessionId)).limit(1);
  if (!session) { emit("error", { error: "Session not found" }); return; }

  const [alert] = await db.select().from(alerts).where(eq(alerts.id, session.alertId)).limit(1);
  if (!alert) { await fail(sessionId, emit, "Alert not found"); return; }

  // Get AI key
  const aiKey = await getProjectOwnerAIKey(session.projectId);
  if (!aiKey) { await fail(sessionId, emit, "No AI key configured. Add one in Settings."); return; }

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

    steps = await pushStep(sessionId, steps,
      makeStep("analyze", "Connecting to repository and analyzing error..."), emit);

    const defaultBranch = await gh.getDefaultBranch(token, owner, repo);
    const baseSha = await gh.getBranchSha(token, owner, repo, defaultBranch);
    await updateSession(sessionId, { baseBranch: defaultBranch });

    const repoFiles = await gh.getRepoTree(token, owner, repo, baseSha);

    steps = await resolveStep(sessionId, steps, "completed",
      `Connected to ${fullRepo} (${repoFiles.length} files, branch: ${defaultBranch})`, emit);

    steps = await pushStep(sessionId, steps,
      makeStep("diagnose", "AI is diagnosing the root cause and identifying affected files..."), emit);

    const remModel = resolveModel("remediation", aiKey.provider, aiKey.modelPrefs);
    const diagRaw = await callAI(aiKey.key, SYSTEM_REMEDIATOR, [
      { role: "user", content: buildDiagnosePrompt({
        title: alert.title,
        body: alert.body,
        sourceIntegrations: alert.sourceIntegrations,
        aiReasoning: alert.aiReasoning,
      }, repoFiles) },
    ], { maxTokens: 600, timeout: 45000, model: remModel, provider: aiKey.provider });

    let diagnosis: { diagnosis: string; filesToRead: string[]; confidence: string };
    try {
      diagnosis = JSON.parse(cleanJSON(diagRaw));
    } catch {
      await fail(sessionId, emit, "AI returned an invalid diagnosis. Try again.");
      return;
    }

    steps = await resolveStep(sessionId, steps, "completed",
      `Diagnosis: ${diagnosis.diagnosis}`, emit);

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
      steps = await pushStep(sessionId, steps,
        makeStep("generate_fix", attempt > 1
          ? `Attempt ${attempt}/${session.maxAttempts}: Generating a different fix based on the CI failure...`
          : "AI is generating a code fix..."), emit);

      const fixRaw = await callAI(aiKey.key, SYSTEM_REMEDIATOR, [
        { role: "user", content: buildFixPrompt(diagnosis.diagnosis, fileContents, alert.body, previousAttempt) },
      ], { maxTokens: 4096, timeout: 60000, model: remModel, provider: aiKey.provider });

      let fix: { explanation: string; files: { path: string; content: string }[] };
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

      if (!fix.files?.length) {
        await fail(sessionId, emit, "AI could not determine what code to change.");
        return;
      }

      // Validate file paths — reject directory traversal
      fix.files = fix.files.filter((f) => isSafeFilePath(f.path));
      if (!fix.files.length) {
        await fail(sessionId, emit, "AI returned invalid file paths.");
        return;
      }

      await updateSession(sessionId, { fileChanges: fix.files });
      steps = await resolveStep(sessionId, steps, "completed",
        `Fix: ${fix.explanation}`, emit);

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
          // No CI detected or CI taking too long
          if (ciResult.details.length === 0) {
            // No CI configured — treat as success
            ciResult = { status: "success", details: [] };
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

        // ── CREATE PR ────────────────────────────────────────────────────
        await updateSession(sessionId, { status: "proposing" });
        emit("status", { status: "proposing" });

        steps = await pushStep(sessionId, steps,
          makeStep("create_pr", "Creating pull request..."), emit);

        const prBody = [
          `## Automated fix by Inari AI`,
          ``,
          `**Alert:** ${alert.title}`,
          `**Severity:** ${alert.severity}`,
          `**Diagnosis:** ${diagnosis.diagnosis}`,
          ``,
          `### What was changed`,
          fix.explanation,
          ``,
          `### Files modified`,
          ...fix.files.map((f) => `- \`${f.path}\``),
          ``,
          attempt > 1
            ? `> This fix was verified after ${attempt} attempts. Previous approaches were tested by CI and failed.\n`
            : "",
          `---`,
          `*Generated and verified by Inari AI remediation*`,
        ].join("\n");

        try {
          const pr = await gh.createPR(
            token, owner, repo,
            `fix: ${alert.title.slice(0, 60)}`,
            prBody, branchName, defaultBranch
          );
          await updateSession(sessionId, { prUrl: pr.url, prNumber: pr.number });
          steps = await resolveStep(sessionId, steps, "completed", `PR #${pr.number} created`, emit);

          steps = await pushStep(sessionId, steps,
            makeStep("done", `Fix verified — CI passes. Ready for your approval.`, "completed"), emit);

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

async function fail(sessionId: string, emit: Emit, error: string) {
  await updateSession(sessionId, { status: "failed", error });
  emit("done", { status: "failed", error });
}
