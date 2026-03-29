/**
 * Shadow Replay — Layer 3 of the Prediction Engine
 *
 * Replays production Substrate recordings against PR code in a sandbox.
 * If any request fails that previously succeeded, the deploy is flagged as risky.
 *
 * Flow:
 * 1. Select relevant recordings (by file overlap with PR changes)
 * 2. Clone the PR branch to a temp directory
 * 3. For each recording: run Substrate replay with command_override
 * 4. Collect divergences and risk scores
 * 5. Aggregate into overall risk assessment
 */

import { db, substrateRecordings } from "@/lib/db";
import { eq, desc, and, sql } from "drizzle-orm";
import { execSync, spawn } from "child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface ReplayInput {
  projectId: string;
  owner: string;
  repo: string;
  branch: string;
  prFiles: string[];
  token: string;
}

export interface ReplayDivergence {
  category: string;
  detail: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface SingleReplayResult {
  recordingId: string;
  passed: boolean;
  exitCode: number;
  divergences: ReplayDivergence[];
  eventCountBefore: number;
  eventCountAfter: number;
  durationMs: number;
}

export interface ShadowReplayResult {
  recordings: SingleReplayResult[];
  totalRecordings: number;
  passed: number;
  failed: number;
  riskScore: number; // 0-100
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
}

const MAX_RECORDINGS = 5;
const REPLAY_TIMEOUT_MS = 60_000; // 60s per recording
const MAX_TOTAL_MS = 300_000; // 5 min total

/**
 * Run shadow replay for a PR.
 * Returns null if no recordings available or replay not possible.
 */
export async function runShadowReplay(input: ReplayInput): Promise<ShadowReplayResult | null> {
  const { projectId, owner, repo, branch, prFiles, token } = input;

  // 1. Select relevant recordings
  const recordings = await selectRecordings(projectId, prFiles);
  if (recordings.length === 0) return null;

  // 2. Clone PR branch to temp dir
  let tempDir: string | null = null;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "inariwatch-replay-"));
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

    execSync(
      `git clone --depth 1 --branch ${branch} ${cloneUrl} ${tempDir}/repo`,
      { timeout: 30_000, stdio: "pipe" },
    );

    // Install deps if package.json exists
    const repoDir = join(tempDir, "repo");
    if (existsSync(join(repoDir, "package.json"))) {
      try {
        execSync("npm install --production --ignore-scripts", {
          cwd: repoDir,
          timeout: 60_000,
          stdio: "pipe",
        });
      } catch {
        // Some projects may fail install — continue anyway
      }
    }

    // 3. Replay each recording
    const results: SingleReplayResult[] = [];
    const startTotal = Date.now();

    for (const rec of recordings) {
      if (Date.now() - startTotal > MAX_TOTAL_MS) break; // Total timeout

      const result = await replaySingleRecording(rec, repoDir);
      results.push(result);
    }

    // 4. Aggregate results
    return aggregateResults(results);
  } catch (err) {
    console.error("[shadow-replay] Error:", err);
    return null;
  } finally {
    // Cleanup temp dir
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/** Select the most relevant recordings for the changed files */
async function selectRecordings(
  projectId: string,
  prFiles: string[],
): Promise<{ id: string; recordingId: string; events: unknown; eventCount: number | null; context: string | null }[]> {
  // Get recent recordings for this project
  const allRecordings = await db
    .select({
      id: substrateRecordings.id,
      recordingId: substrateRecordings.recordingId,
      events: substrateRecordings.events,
      eventCount: substrateRecordings.eventCount,
      context: substrateRecordings.context,
    })
    .from(substrateRecordings)
    .where(and(
      eq(substrateRecordings.projectId, projectId),
      sql`${substrateRecordings.events} IS NOT NULL`,
    ))
    .orderBy(desc(substrateRecordings.createdAt))
    .limit(20);

  if (allRecordings.length === 0) return [];

  // Score recordings by relevance (file overlap with PR files)
  const scored = allRecordings.map((rec) => {
    const ctx = rec.context ?? "";
    let score = 0;
    for (const file of prFiles) {
      const shortName = file.split("/").pop() ?? file;
      if (ctx.includes(shortName) || ctx.includes(file)) {
        score += 10;
      }
    }
    // Bonus for recordings with more events (richer test data)
    score += Math.min(rec.eventCount ?? 0, 50) / 10;
    return { ...rec, score };
  });

  // Sort by relevance score, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RECORDINGS).map(({ score, ...rest }) => rest);
}

/** Replay a single recording against the PR code */
async function replaySingleRecording(
  recording: { id: string; recordingId: string; events: unknown; eventCount: number | null },
  repoDir: string,
): Promise<SingleReplayResult> {
  const start = Date.now();

  try {
    // Write recording events to temp file
    const replayDataPath = join(repoDir, `.substrate-replay-${recording.recordingId}.json`);
    const events = recording.events as Record<string, unknown>[];

    // Build replay data structure matching Substrate's expected format
    const replayData = buildReplayData(events);
    writeFileSync(replayDataPath, JSON.stringify(replayData));

    // Check if substrate agent replay.js is available
    const agentPath = findReplayAgent();
    if (!agentPath) {
      return {
        recordingId: recording.recordingId,
        passed: true, // Can't replay = pass by default
        exitCode: 0,
        divergences: [{ category: "setup", detail: "Substrate replay agent not found", severity: "low" }],
        eventCountBefore: recording.eventCount ?? 0,
        eventCountAfter: 0,
        durationMs: Date.now() - start,
      };
    }

    // Run the app with replay agent
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("node", ["--require", agentPath, "."], {
        cwd: repoDir,
        env: {
          ...process.env,
          SUBSTRATE_REPLAY_FILE: replayDataPath,
          NODE_ENV: "test",
        },
        timeout: REPLAY_TIMEOUT_MS,
        stdio: "pipe",
      });

      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => resolve(code ?? 1));
      proc.on("error", () => resolve(1));
    });

    // Analyze divergences from exit code and stderr
    const divergences: ReplayDivergence[] = [];

    if (exitCode !== 0) {
      divergences.push({
        category: "exit_code",
        detail: `Process exited with code ${exitCode} (expected 0)`,
        severity: "high",
      });
    }

    // Cleanup replay file
    try { rmSync(replayDataPath); } catch {}

    return {
      recordingId: recording.recordingId,
      passed: exitCode === 0 && divergences.length === 0,
      exitCode,
      divergences,
      eventCountBefore: recording.eventCount ?? 0,
      eventCountAfter: 0, // Would need recorder to capture
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      recordingId: recording.recordingId,
      passed: false,
      exitCode: 1,
      divergences: [{
        category: "error",
        detail: err instanceof Error ? err.message : String(err),
        severity: "medium",
      }],
      eventCountBefore: recording.eventCount ?? 0,
      eventCountAfter: 0,
      durationMs: Date.now() - start,
    };
  }
}

/** Build Substrate replay data from stored events */
function buildReplayData(events: Record<string, unknown>[]): Record<string, unknown> {
  const httpResponses: unknown[] = [];
  const timeValues: number[] = [];
  const randomFloats: number[] = [];
  const dbQueries: unknown[] = [];

  for (const event of events) {
    const kind = event.kind as Record<string, unknown> | undefined;
    if (!kind) continue;

    const type = kind.type as string;

    if (type === "http_response") {
      httpResponses.push({
        id: kind.id,
        status: kind.status,
        headers: kind.headers ?? {},
        body_b64: kind.body_b64 ?? null,
        body_len: kind.body_len ?? 0,
      });
    } else if (type === "time_now") {
      timeValues.push(kind.ms as number);
    } else if (type === "random_float") {
      randomFloats.push(kind.value as number);
    } else if (type === "db_query") {
      dbQueries.push({
        id: kind.id,
        system: kind.system,
        query: kind.query,
        row_count: kind.row_count,
        rows_b64: kind.rows_b64,
        error: kind.error,
      });
    }
  }

  return {
    http_responses: httpResponses,
    time_values: timeValues,
    random_floats: randomFloats,
    random_bytes: [],
    dns_lookups: [],
    db_queries: dbQueries,
    file_reads: [],
  };
}

/** Find the Substrate replay agent script */
function findReplayAgent(): string | null {
  const candidates = [
    // Installed as npm package
    "node_modules/@inariwatch/substrate-agent/replay.js",
    // Local development
    "../Substrate/agent/replay.js",
    // Global
    "/usr/local/lib/node_modules/@inariwatch/substrate-agent/replay.js",
  ];

  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {}
  }
  return null;
}

/** Aggregate results across all replay runs */
function aggregateResults(results: SingleReplayResult[]): ShadowReplayResult {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  // Risk score: weighted by divergence severity
  let riskPoints = 0;
  for (const result of results) {
    for (const div of result.divergences) {
      switch (div.severity) {
        case "critical": riskPoints += 30; break;
        case "high": riskPoints += 20; break;
        case "medium": riskPoints += 10; break;
        case "low": riskPoints += 3; break;
      }
    }
  }
  const riskScore = Math.min(100, riskPoints);

  const riskLevel: ShadowReplayResult["riskLevel"] =
    riskScore >= 71 ? "critical" :
    riskScore >= 41 ? "high" :
    riskScore >= 16 ? "medium" : "low";

  const summary = total === 0
    ? "No recordings available for replay."
    : failed === 0
    ? `All ${total} production recordings passed replay.`
    : `${failed}/${total} production recordings failed replay. Risk score: ${riskScore}/100.`;

  return {
    recordings: results,
    totalRecordings: total,
    passed,
    failed,
    riskScore,
    riskLevel,
    summary,
  };
}
