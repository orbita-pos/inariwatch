/**
 * Substrate runner — invokes the `substrate` Rust CLI binary to replay
 * a recording against changed code and produce a deterministic risk
 * assessment + behavioral diff.
 *
 * Usage in our pipeline:
 *   - What-If service tries this FIRST when SUBSTRATE_BINARY_PATH is set
 *     and a recording is available; falls back to AI prediction otherwise
 *   - Future Gates 13-17 may also call into this for behavioral drift +
 *     performance regression checks (same machinery, different consumer)
 *
 * Why a wrapper instead of direct spawn at call sites:
 *   - One place to enforce timeouts, output size limits, error mapping
 *   - One place to materialize the recording JSON to a temp .substrate
 *     file (the binary reads from disk, not stdin)
 *   - One place to pin command-injection guards on the user-supplied
 *     `command` string
 *
 * Production deployment note: the Windows .exe path used in dev needs to
 * be replaced by a Linux build deployed to Hetzner workers before this
 * runs in prod. SUBSTRATE_BINARY_PATH defaults to null = "use AI fallback".
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Shape of the JSON the binary emits with `--format json`. Mirrors what
 * `substrate simulate` prints today (verified against the Windows build
 * 0.1.0 — see worker-side validation when deploying a new binary version).
 */
export interface SubstrateSimulateRaw {
  results: Array<{
    recording_path: string;
    matched: boolean;
    exit_code: number;
    event_count_before: number;
    event_count_after: number;
    risk_report: {
      score: number;
      level: RiskLevel;
      blast_radius: {
        http_paths: string[];
        db_tables: string[];
        file_paths: string[];
        total_surfaces: number;
      };
      scored_changes: unknown[];
      recommendations: string[];
    };
  }>;
  overall_score: number;
  overall_level: RiskLevel;
  overall_recommendations: string[];
}

/** Caller-friendly shape — flattens the per-recording array to a single
 *  result (we only ever pass ONE recording per call). */
export interface SubstrateSimulateResult {
  matched: boolean;
  exitCode: number;
  eventCountBefore: number;
  eventCountAfter: number;
  riskScore: number;
  riskLevel: RiskLevel;
  blastRadius: {
    httpPaths: string[];
    dbTables: string[];
    filePaths: string[];
    totalSurfaces: number;
  };
  recommendations: string[];
}

export interface SubstrateRecordingShape {
  meta: {
    id: string;
    started_at: string;
    ended_at: string;
    command: string[];
    cwd: string;
    env: Record<string, string>;
    substrate_version: string;
    runtime: string;
  };
  events: unknown[];
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class SubstrateNotConfiguredError extends Error {
  constructor() {
    super("SUBSTRATE_BINARY_PATH not set — Substrate runner unavailable");
  }
}

export class SubstrateTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`substrate binary exceeded ${timeoutMs}ms timeout`);
  }
}

export class SubstrateInvocationError extends Error {
  constructor(public readonly stderr: string, public readonly exitCode: number | null) {
    super(`substrate binary failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true if the runner is available (binary path configured).
 * Callers use this to short-circuit before doing expensive setup.
 */
export function isSubstrateConfigured(): boolean {
  return Boolean(process.env.SUBSTRATE_BINARY_PATH);
}

/**
 * Run `substrate simulate` against a recording with a changed command.
 *
 * - `recording`: full .substrate file shape (we materialize it to a temp file)
 * - `command`: the command-line that runs the FIXED code (e.g. "node app-v2.js")
 * - `cwd`: working directory for the command (defaults to recording.meta.cwd)
 * - `timeoutMs`: hard cap on binary runtime; default 60s
 *
 * Returns a flat result. Throws SubstrateNotConfiguredError if no binary
 * path is set, SubstrateTimeoutError on hang, SubstrateInvocationError on
 * non-zero exit. Callers should catch and degrade gracefully.
 */
export async function runSubstrateSimulate(opts: {
  recording: SubstrateRecordingShape;
  command: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<SubstrateSimulateResult> {
  const binaryPath = process.env.SUBSTRATE_BINARY_PATH;
  if (!binaryPath) throw new SubstrateNotConfiguredError();

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const cwd = opts.cwd ?? opts.recording.meta.cwd;

  // Reject obvious command-injection patterns. The CLI receives `command`
  // as a single string passed to its own shell logic; if a remediation
  // payload contains backticks/semicolons/&&, that's almost certainly a
  // bug or attack — refuse instead of executing.
  if (/[`;&|$<>\n]/.test(opts.command)) {
    throw new SubstrateInvocationError("command contains shell metacharacters", -1);
  }

  // Materialize the recording to a temp file. The binary reads .substrate
  // files from disk (no stdin support). Use mkdtemp so we get a unique
  // directory we can safely clean up regardless of file-name collisions.
  const tempDir = await mkdtemp(join(tmpdir(), "iw-whatif-"));
  const recordingPath = join(tempDir, "recording.substrate");
  await writeFile(recordingPath, JSON.stringify(opts.recording));

  try {
    const raw = await spawnBinary({
      binaryPath,
      args: ["simulate", "--command", opts.command, "--format", "json", recordingPath],
      cwd,
      timeoutMs,
    });
    const parsed = parseSimulateOutput(raw);
    return flattenResult(parsed);
  } finally {
    // Best-effort cleanup. Binary occasionally leaves a `.tmp` next to the
    // recording — we glob-delete by ignoring missing files.
    await unlink(recordingPath).catch(() => {});
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

interface SpawnOpts {
  binaryPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

function spawnBinary(opts: SpawnOpts): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Explicit cast: the overload selection on Windows trips when env is
    // narrowed to `{ PATH }`. We're committed to the no-shell, no-stdio
    // path which always produces real streams (never null).
    // Pass the bare minimum env to the binary: PATH (binary loader needs it)
    // + NODE_ENV (required by our project's ProcessEnv typing). We
    // intentionally do NOT inherit DATABASE_URL, NEXTAUTH_SECRET, etc. — the
    // binary should never have access to our app's secrets.
    const safeEnv = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "production",
    };
    const child: ChildProcessWithoutNullStreams = spawn(opts.binaryPath, opts.args, {
      cwd: opts.cwd,
      shell: false,
      env: safeEnv,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new SubstrateTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);

    // Cap output to 4MB to avoid OOM on a runaway binary. simulate output
    // is typically <50KB; anything bigger is pathological.
    const MAX_OUTPUT = 4 * 1024 * 1024;
    let outputSize = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT) {
        killed = true;
        child.kill("SIGKILL");
        reject(new SubstrateInvocationError(`stdout exceeded ${MAX_OUTPUT} bytes`, -1));
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (killed) return;
      reject(new SubstrateInvocationError(err.message, -1));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (killed) return;
      // simulate exits non-zero when --fail-on threshold is met. Without
      // that flag (we omit it), a non-zero exit indicates a real failure.
      if (code !== 0) {
        reject(new SubstrateInvocationError(stderr || stdout, code));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseSimulateOutput(stdout: string): SubstrateSimulateRaw {
  // The binary may print non-JSON warnings to stdout BEFORE the JSON
  // payload (e.g. "Loading recording..."). Find the JSON object by
  // locating the first `{` and parsing from there.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new SubstrateInvocationError("no JSON in stdout", 0);
  }
  try {
    return JSON.parse(stdout.slice(jsonStart)) as SubstrateSimulateRaw;
  } catch (e) {
    throw new SubstrateInvocationError(
      `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }
}

function flattenResult(raw: SubstrateSimulateRaw): SubstrateSimulateResult {
  const first = raw.results[0];
  if (!first) {
    throw new SubstrateInvocationError("simulate returned zero results", 0);
  }
  return {
    matched: first.matched,
    exitCode: first.exit_code,
    eventCountBefore: first.event_count_before,
    eventCountAfter: first.event_count_after,
    riskScore: first.risk_report.score,
    riskLevel: first.risk_report.level,
    blastRadius: {
      httpPaths: first.risk_report.blast_radius.http_paths,
      dbTables: first.risk_report.blast_radius.db_tables,
      filePaths: first.risk_report.blast_radius.file_paths,
      totalSurfaces: first.risk_report.blast_radius.total_surfaces,
    },
    recommendations: first.risk_report.recommendations,
  };
}
