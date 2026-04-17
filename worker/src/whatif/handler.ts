/**
 * What-If handler — the main worker endpoint for deterministic replay.
 *
 * POST /worker/whatif
 * Body: { sessionId, remediationId }
 *
 * Orchestrates the full pipeline:
 *   1. DB lookup: remediation → repo, commitSha, fileChanges
 *   2. DB lookup: substrate recording for sessionId
 *   3. Prepare workspace (shallow clone + apply patches)
 *   4. Detect entry point (npm start / node app.js / Dockerfile CMD)
 *   5. Materialize recording JSON to a temp .substrate file
 *   6. Spawn substrate simulate, parse JSON
 *   7. Cleanup workspace + temp files
 *   8. Return typed result
 *
 * Safety / failure model:
 *   - Every external call is timeboxed; total request budget is 120s
 *   - Any failure is mapped to a typed error code the web caller can
 *     branch on ("no_recording" / "no_entry_point" / "clone_failed" / etc.)
 *   - Workspace + temp files cleaned up in finally even on throw
 *   - Substrate binary path comes from env; missing = 503 with a clear
 *     message so the web caller falls back to AI
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { remediationSessions, substrateRecordings } from "../db.js";
import { prepareWorkspace, PrepareWorkspaceError } from "./prepare-workspace.js";
import { detectCommand } from "./detect-command.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type WhatIfErrorCode =
  | "missing_fields"
  | "remediation_not_found"
  | "no_recording"
  | "no_fix_commit"
  | "no_entry_point"
  | "clone_failed"
  | "substrate_not_configured"
  | "substrate_failed"
  | "substrate_timeout";

export interface WhatIfResponse {
  sessionId: string;
  remediationId: string;
  fixCommitSha: string;
  matched: boolean;
  exitCode: number;
  eventCountBefore: number;
  eventCountAfter: number;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  blastRadius: {
    httpPaths: string[];
    dbTables: string[];
    filePaths: string[];
    totalSurfaces: number;
  };
  recommendations: string[];
  detectedCommand: string;
  commandSource: string;
}

export interface WhatIfError {
  error: string;
  code: WhatIfErrorCode;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function runWhatIf(
  body: { sessionId: string; remediationId: string; githubToken?: string },
): Promise<{ ok: true; result: WhatIfResponse } | { ok: false; error: WhatIfError; status: number }> {
  const { sessionId, remediationId, githubToken } = body;
  if (!sessionId || !remediationId) {
    return fail("missing_fields", "sessionId and remediationId required", 400);
  }

  // ── Load DB context
  const [rem] = await db
    .select({
      id: remediationSessions.id,
      repo: remediationSessions.repo,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      branch: remediationSessions.branch,
      fileChanges: remediationSessions.fileChanges,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, remediationId))
    .limit(1);

  if (!rem) return fail("remediation_not_found", `remediation ${remediationId} not found`, 404);
  if (!rem.mergedCommitSha) {
    // Branch-only remediations haven't merged yet — no canonical commit
    // to pin the replay at. Reviewer can re-run What-If after merge.
    return fail("no_fix_commit", "remediation has no merged_commit_sha yet", 422);
  }
  if (!rem.repo) return fail("no_fix_commit", "remediation has no repo field", 422);

  const [rec] = await db
    .select({
      events: substrateRecordings.events,
      command: substrateRecordings.command,
      runtime: substrateRecordings.runtime,
      startedAt: substrateRecordings.startedAt,
      endedAt: substrateRecordings.endedAt,
      recordingId: substrateRecordings.recordingId,
    })
    .from(substrateRecordings)
    .where(eq(substrateRecordings.sessionId, sessionId))
    .limit(1);

  if (!rec || !Array.isArray(rec.events) || rec.events.length === 0) {
    return fail("no_recording", `no substrate recording for session ${sessionId}`, 422);
  }

  const fileChanges = Array.isArray(rem.fileChanges)
    ? (rem.fileChanges as Array<{ path: string; content: string }>)
    : [];

  // ── Prepare workspace (clone + patch)
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | null = null;
  let recordingPath: string | null = null;

  try {
    workspace = await prepareWorkspace({
      repo: rem.repo,
      commitSha: rem.mergedCommitSha,
      fileChanges,
      githubToken,
    });

    // ── Detect entry point
    const detected = await detectCommand(workspace.path);
    if (!detected) {
      return fail(
        "no_entry_point",
        `could not infer entry point for repo ${rem.repo} at ${rem.mergedCommitSha.slice(0, 8)}`,
        422,
      );
    }

    // ── Materialize recording to .substrate file
    const recordingDir = await mkdtemp(join(tmpdir(), "iw-whatif-rec-"));
    recordingPath = join(recordingDir, "recording.substrate");
    const recordingJson = {
      meta: {
        id: rec.recordingId,
        started_at: (rec.startedAt ?? new Date()).toISOString(),
        ended_at: (rec.endedAt ?? new Date()).toISOString(),
        command: (rec.command ?? "node app.js").split(/\s+/),
        cwd: workspace.path,
        env: {},
        substrate_version: "0.1.0",
        runtime: rec.runtime ?? "node",
      },
      events: rec.events,
    };
    await writeFile(recordingPath, JSON.stringify(recordingJson));

    // ── Spawn substrate simulate
    const binary = process.env.SUBSTRATE_BINARY_PATH;
    if (!binary) {
      return fail(
        "substrate_not_configured",
        "SUBSTRATE_BINARY_PATH env not set on worker",
        503,
      );
    }

    const simResult = await runSubstrateSimulate({
      binary,
      recordingPath,
      command: detected.command,
      cwd: workspace.path,
      timeoutMs: 90_000,
    });

    return {
      ok: true,
      result: {
        sessionId,
        remediationId,
        fixCommitSha: rem.mergedCommitSha,
        matched: simResult.matched,
        exitCode: simResult.exitCode,
        eventCountBefore: simResult.eventCountBefore,
        eventCountAfter: simResult.eventCountAfter,
        riskScore: simResult.riskScore,
        riskLevel: simResult.riskLevel,
        blastRadius: simResult.blastRadius,
        recommendations: simResult.recommendations,
        detectedCommand: detected.command,
        commandSource: detected.source,
      },
    };
  } catch (err) {
    if (err instanceof PrepareWorkspaceError) {
      return fail("clone_failed", `prepare-workspace (${err.phase}): ${err.message}`, 502);
    }
    if (err instanceof SubstrateTimeout) {
      return fail("substrate_timeout", err.message, 504);
    }
    if (err instanceof SubstrateFailed) {
      return fail("substrate_failed", err.message, 502);
    }
    throw err;
  } finally {
    if (recordingPath) await unlink(recordingPath).catch(() => {});
    if (workspace) await workspace.cleanup();
  }
}

// ── Substrate spawn (worker-local, doesn't import the web-side runner) ───

class SubstrateTimeout extends Error {}
class SubstrateFailed extends Error {}

interface SimulateResult {
  matched: boolean;
  exitCode: number;
  eventCountBefore: number;
  eventCountAfter: number;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  blastRadius: {
    httpPaths: string[];
    dbTables: string[];
    filePaths: string[];
    totalSurfaces: number;
  };
  recommendations: string[];
}

function runSubstrateSimulate(opts: {
  binary: string;
  recordingPath: string;
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<SimulateResult> {
  return new Promise((resolve, reject) => {
    // Reject obvious command-injection patterns before we ever reach the
    // binary. The CLI receives `command` as a single string; backticks,
    // semicolons, and pipe operators have no legitimate place there.
    if (/[`;&|$<>\n]/.test(opts.command)) {
      reject(new SubstrateFailed(`command contains shell metacharacters`));
      return;
    }

    const child = spawn(
      opts.binary,
      ["simulate", "--command", opts.command, "--format", "json", opts.recordingPath],
      {
        cwd: opts.cwd,
        shell: false,
        env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "production" },
      },
    );

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new SubstrateTimeout(`substrate simulate exceeded ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const MAX_OUTPUT = 4 * 1024 * 1024;
    let outputSize = 0;
    child.stdout.on("data", (c: Buffer) => {
      outputSize += c.length;
      if (outputSize > MAX_OUTPUT) {
        killed = true;
        child.kill("SIGKILL");
        reject(new SubstrateFailed(`stdout exceeded ${MAX_OUTPUT} bytes`));
        return;
      }
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (err) => {
      if (killed) return;
      clearTimeout(timeout);
      reject(new SubstrateFailed(err.message));
    });
    child.on("close", (code) => {
      if (killed) return;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new SubstrateFailed(`exit ${code}: ${(stderr || stdout).slice(0, 500)}`));
        return;
      }
      try {
        const jsonStart = stdout.indexOf("{");
        if (jsonStart < 0) {
          reject(new SubstrateFailed("no JSON in stdout"));
          return;
        }
        const parsed = JSON.parse(stdout.slice(jsonStart));
        const first = parsed.results?.[0];
        if (!first) {
          reject(new SubstrateFailed("simulate returned zero results"));
          return;
        }
        resolve({
          matched: first.matched,
          exitCode: first.exit_code,
          eventCountBefore: first.event_count_before,
          eventCountAfter: first.event_count_after,
          riskScore: first.risk_report.score,
          riskLevel: first.risk_report.level,
          blastRadius: {
            httpPaths: first.risk_report.blast_radius.http_paths ?? [],
            dbTables: first.risk_report.blast_radius.db_tables ?? [],
            filePaths: first.risk_report.blast_radius.file_paths ?? [],
            totalSurfaces: first.risk_report.blast_radius.total_surfaces ?? 0,
          },
          recommendations: first.risk_report.recommendations ?? [],
        });
      } catch (e) {
        reject(new SubstrateFailed(`parse failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

function fail(code: WhatIfErrorCode, error: string, status: number): {
  ok: false; error: WhatIfError; status: number;
} {
  return { ok: false, error: { code, error }, status };
}
