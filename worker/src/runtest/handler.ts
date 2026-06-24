/**
 * Inari Guard — `run_test` worker handler.
 *
 * POST /worker/run_test
 * Body: {
 *   sessionId:   string  — Inari Guard testGenerationSessions.id (for logging)
 *   repo:        string  — GitHub slug "owner/name"
 *   ref:         string  — branch or commit to clone from (default "HEAD")
 *   testFiles:   Array<{ path, content }>  — generated test(s) to write
 *   sourceFile?: { path, content }  — optional override of the source-under-test
 *                                     (useful when verifying against an unmerged fix)
 *   githubToken?: string  — required for private repos
 *   timeoutMs?:  number   — total budget incl. install (default 180_000)
 * }
 *
 * What it does:
 *   1. Shallow clones the repo at `ref` into a temp dir.
 *   2. Detects the test framework from package.json (vitest > jest > mocha
 *      > playwright as priority — vitest is the most common in this stack).
 *   3. Runs `npm ci` (or `pnpm install --frozen-lockfile` if pnpm-lock present).
 *   4. Writes each generated test file to disk.
 *   5. Spawns the framework runner targeting ONLY the new test file(s) so
 *      we don't pay for the entire suite (~minutes on a real repo).
 *   6. Captures stdout/stderr + exit code, parses pass/fail counts.
 *   7. Cleans up the temp dir.
 *
 * Why this lives on the worker instead of inline in the cloud route:
 *   - npm install is RAM/disk heavy (200-500MB for a typical Next.js app).
 *   - The runner spawns child processes — Vercel's serverless is hostile
 *     to long-running spawn'd jobs.
 *   - Hetzner has the same Docker tooling the container agent uses; we
 *     can reuse it later for sandboxed execution.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RunTestRequest {
  sessionId: string;
  repo: string;
  ref?: string;
  testFiles: Array<{ path: string; content: string }>;
  sourceFile?: { path: string; content: string };
  githubToken?: string;
  timeoutMs?: number;
}

export type RunTestErrorCode =
  | "missing_fields"
  | "clone_failed"
  | "install_failed"
  | "no_framework"
  | "runner_failed"
  | "runner_timeout";

export interface RunTestResponse {
  sessionId: string;
  passed: boolean;
  framework: string;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunTestError {
  error: string;
  code: RunTestErrorCode;
  detail?: string;
}

// ── Handler ────────────────────────────────────────────────────────────────

/**
 * Top-level runner. Returns a discriminated union so the HTTP layer can
 * branch on `ok` for the status code:
 *
 *   { ok: true,  result: RunTestResponse }   → 200
 *   { ok: false, status, error: RunTestError } → status (400/500/503/504)
 */
export async function runTest(
  body: RunTestRequest,
): Promise<
  | { ok: true; result: RunTestResponse }
  | { ok: false; status: number; error: RunTestError }
> {
  if (!body.sessionId || !body.repo || !Array.isArray(body.testFiles) || body.testFiles.length === 0) {
    return {
      ok: false,
      status: 400,
      error: {
        error: "Missing required fields: sessionId, repo, testFiles",
        code: "missing_fields",
      },
    };
  }

  const ref = body.ref ?? "HEAD";
  const timeoutMs = body.timeoutMs ?? 180_000;
  const overallDeadline = Date.now() + timeoutMs;
  const startedAt = Date.now();

  // ── 1. Clone ─────────────────────────────────────────────────────────────
  const workspace = await mkdtemp(join(tmpdir(), "iw-runtest-"));
  const cleanup = async () => {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const cloneUrl = buildCloneUrl(body.repo, body.githubToken);
    try {
      await runCommand(
        "git",
        ["clone", "--depth=1", "--no-tags", ...(ref !== "HEAD" ? ["--branch", ref] : []), cloneUrl, workspace],
        workspace,
        Math.min(60_000, overallDeadline - Date.now()),
      );
    } catch (err) {
      await cleanup();
      return {
        ok: false,
        status: 500,
        error: {
          error: "git clone failed",
          code: "clone_failed",
          detail: scrubToken(err instanceof Error ? err.message : String(err), body.githubToken),
        },
      };
    }

    // ── 2. Detect framework + package manager ─────────────────────────────
    let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } = {};
    try {
      const raw = await readFile(join(workspace, "package.json"), "utf8");
      pkg = JSON.parse(raw);
    } catch {
      await cleanup();
      return {
        ok: false,
        status: 422,
        error: { error: "package.json not found at repo root", code: "no_framework" },
      };
    }
    const framework = detectFramework(pkg);
    if (!framework) {
      await cleanup();
      return {
        ok: false,
        status: 422,
        error: { error: "no supported test framework found in package.json", code: "no_framework" },
      };
    }

    const pm = await detectPackageManager(workspace);

    // ── 3. Install deps ─────────────────────────────────────────────────────
    try {
      const installCmd = pm === "pnpm" ? ["pnpm", "install", "--frozen-lockfile"]
        : pm === "yarn" ? ["yarn", "install", "--frozen-lockfile"]
        : ["npm", "ci"];
      await runCommand(
        installCmd[0],
        installCmd.slice(1),
        workspace,
        Math.min(180_000, overallDeadline - Date.now()),
      );
    } catch (err) {
      await cleanup();
      return {
        ok: false,
        status: 500,
        error: {
          error: `${pm} install failed`,
          code: "install_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // ── 4. Write generated files (source override + test) ──────────────────
    if (body.sourceFile) {
      await writeFileSafe(workspace, body.sourceFile.path, body.sourceFile.content);
    }
    for (const t of body.testFiles) {
      await writeFileSafe(workspace, t.path, t.content);
    }

    // ── 5. Run the framework against ONLY the generated test paths ─────────
    const testPaths = body.testFiles.map((t) => t.path);
    const runnerArgs = buildRunnerArgs(framework, testPaths);

    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    let runnerTimedOut = false;
    try {
      const result = await runCommand(
        runnerArgs[0],
        runnerArgs.slice(1),
        workspace,
        Math.min(120_000, overallDeadline - Date.now()),
        /* capture */ true,
      );
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed? ?out/i.test(msg)) {
        runnerTimedOut = true;
      } else {
        await cleanup();
        return {
          ok: false,
          status: 500,
          error: { error: "runner failed to start", code: "runner_failed", detail: msg },
        };
      }
    }

    await cleanup();

    if (runnerTimedOut) {
      return {
        ok: false,
        status: 504,
        error: { error: "runner exceeded timeout", code: "runner_timeout" },
      };
    }

    const counts = parseRunnerCounts(framework, stdout, stderr);
    const response: RunTestResponse = {
      sessionId: body.sessionId,
      passed: exitCode === 0 && counts.failed === 0,
      framework,
      testsRun: counts.run,
      testsPassed: counts.passed,
      testsFailed: counts.failed,
      exitCode,
      durationMs: Date.now() - startedAt,
      stdout: truncate(stdout, 32_000),
      stderr: truncate(stderr, 32_000),
    };
    return { ok: true, result: response };
  } catch (err) {
    await cleanup();
    return {
      ok: false,
      status: 500,
      error: {
        error: "internal error",
        code: "runner_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ── Framework detection ────────────────────────────────────────────────────

/**
 * Map package.json's deps to a known framework. Priority is the most
 * common in the InariWatch ecosystem first — vitest >> jest >> mocha.
 * Exposed for tests.
 */
export function detectFramework(pkg: {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}): string | null {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if ("vitest" in all) return "vitest";
  if ("jest" in all || "@jest/core" in all) return "jest";
  if ("@playwright/test" in all) return "playwright";
  if ("mocha" in all) return "mocha";
  // Fallback: scripts that mention a runner. Useful when the runner is
  // installed transitively (via a workspace, monorepo, etc.).
  const test = pkg.scripts?.test ?? "";
  if (/vitest/i.test(test)) return "vitest";
  if (/jest/i.test(test)) return "jest";
  if (/playwright/i.test(test)) return "playwright";
  if (/mocha/i.test(test)) return "mocha";
  return null;
}

async function detectPackageManager(workspace: string): Promise<"npm" | "pnpm" | "yarn"> {
  try {
    await stat(join(workspace, "pnpm-lock.yaml"));
    return "pnpm";
  } catch {}
  try {
    await stat(join(workspace, "yarn.lock"));
    return "yarn";
  } catch {}
  return "npm";
}

/**
 * Build the argv for invoking the test runner against ONLY the
 * generated paths. We use `npx --no-install` because the workspace
 * just ran an install — the binary is in node_modules/.bin.
 * Exposed for tests.
 */
export function buildRunnerArgs(framework: string, testPaths: string[]): string[] {
  switch (framework) {
    case "vitest":
      return ["npx", "--no-install", "vitest", "run", "--reporter=verbose", ...testPaths];
    case "jest":
      return ["npx", "--no-install", "jest", "--colors=false", ...testPaths];
    case "playwright":
      return ["npx", "--no-install", "playwright", "test", ...testPaths];
    case "mocha":
      return ["npx", "--no-install", "mocha", "--reporter=spec", ...testPaths];
    default:
      // Unreachable when caller pre-checks with detectFramework, but
      // keep a sane fallback that won't crash.
      return ["npx", "--no-install", framework, ...testPaths];
  }
}

// ── Runner output parsing ──────────────────────────────────────────────────

interface RunnerCounts {
  run: number;
  passed: number;
  failed: number;
}

/**
 * Parse pass/fail counts from runner output. Each framework prints
 * results in a different shape, so we run a couple of regex patterns
 * and pick whichever matches. Exit code is the authoritative pass
 * signal — counts are best-effort for UX.
 *
 * Exposed for tests.
 */
export function parseRunnerCounts(
  framework: string,
  stdout: string,
  stderr: string,
): RunnerCounts {
  const text = `${stdout}\n${stderr}`;
  switch (framework) {
    case "vitest": {
      // " Tests   3 passed | 1 failed (4)"
      const m = text.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?\s*\((\d+)\)/);
      if (m) {
        const passed = Number(m[1] ?? 0);
        const failed = Number(m[2] ?? 0);
        const run = Number(m[3] ?? passed + failed);
        return { run, passed, failed };
      }
      return { run: 0, passed: 0, failed: 0 };
    }
    case "jest": {
      // "Tests:       1 failed, 3 passed, 4 total"
      const m = text.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/);
      if (m) {
        const failed = Number(m[1] ?? 0);
        const passed = Number(m[2] ?? 0);
        const run = Number(m[3] ?? passed + failed);
        return { run, passed, failed };
      }
      return { run: 0, passed: 0, failed: 0 };
    }
    case "playwright": {
      // " 3 passed (5s)" / " 1 failed"
      const passedM = text.match(/(\d+)\s+passed/);
      const failedM = text.match(/(\d+)\s+failed/);
      const passed = passedM ? Number(passedM[1]) : 0;
      const failed = failedM ? Number(failedM[1]) : 0;
      return { run: passed + failed, passed, failed };
    }
    case "mocha": {
      // "  3 passing\n  1 failing"
      const passedM = text.match(/(\d+)\s+passing/);
      const failedM = text.match(/(\d+)\s+failing/);
      const passed = passedM ? Number(passedM[1]) : 0;
      const failed = failedM ? Number(failedM[1]) : 0;
      return { run: passed + failed, passed, failed };
    }
    default:
      return { run: 0, passed: 0, failed: 0 };
  }
}

// ── Subprocess helpers ──────────────────────────────────────────────────────

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  capture = false,
): Promise<CommandResult> {
  if (timeoutMs <= 0) throw new Error("budget exhausted before spawn");
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (capture && proc.stdout) {
      proc.stdout.on("data", (b) => {
        stdout += b.toString();
        if (stdout.length > 1_000_000) {
          stdout = stdout.slice(-500_000); // sliding window — keep last 500KB
        }
      });
    }
    if (capture && proc.stderr) {
      proc.stderr.on("data", (b) => {
        stderr += b.toString();
        if (stderr.length > 1_000_000) {
          stderr = stderr.slice(-500_000);
        }
      });
    }
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("timed out"));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(killTimer);
      if (capture) {
        resolve({ stdout, stderr, exitCode: code ?? -1 });
      } else if (code === 0) {
        resolve({ stdout: "", stderr: "", exitCode: 0 });
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

async function writeFileSafe(root: string, relPath: string, content: string): Promise<void> {
  // Sanity-check: refuse anything escaping the root. Defence in depth
  // even though the cloud route already validates.
  const normalized = relPath.replace(/^[\\/]+/, "");
  if (normalized.split(/[/\\]/).some((p) => p === "..")) {
    throw new Error(`path traversal rejected: ${relPath}`);
  }
  const abs = join(root, normalized);
  if (!abs.startsWith(root)) throw new Error(`escapes workspace: ${relPath}`);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

function buildCloneUrl(repo: string, token?: string): string {
  if (token) {
    return `https://x-access-token:${token}@github.com/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

function scrubToken(s: string, token?: string): string {
  if (!token) return s;
  return s.split(token).join("***");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars]`;
}
