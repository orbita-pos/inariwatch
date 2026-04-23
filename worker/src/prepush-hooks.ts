/**
 * Fase 4 — Pre-push strict hooks.
 *
 * After the agent calls submit_fix but before the web app pushes the fix to
 * GitHub, run `tsc --noEmit`, `npm test --silent`, and `npm run lint` inside
 * the same container the agent used. Any failure is fed back into the loop
 * as a synthetic tool_result so the agent can retry apply_patch with the
 * error context — the push to GitHub never happens until the fix is green.
 *
 * Gated by PREPUSH_TESTS_ENABLED. When off, isPrepushEnabled() returns false
 * and the caller skips the check entirely (current behavior preserved).
 *
 * Telemetry: every hook invocation writes one row to ai_usage_logs with
 * feature 'prepush-tsc' | 'prepush-test' | 'prepush-lint', zero tokens,
 * and `error` set to the stderr tail on failure so /admin/remediation-lab
 * can compute pre-push pass/fail rate per phase.
 */

// Pre-push budgets — match REMEDIATION_SYSTEM_ARCHITECTURE.md §4 Fase 4.
const TSC_TIMEOUT_SEC = 60;
const TEST_TIMEOUT_SEC = 90;
const LINT_TIMEOUT_SEC = 30;

// Keep the feedback the agent sees bounded; the model doesn't need the
// full 40-line stack trace, just the failing block.
const MAX_HOOK_OUTPUT_CHARS = 4000;

export type PrepushKind = "tsc" | "test" | "lint";

export interface PrepushHookResult {
  kind: PrepushKind;
  ran: boolean;
  /** null when ran=false (skipped — no tsconfig / no test script / no lint script). */
  passed: boolean | null;
  exitCode: number | null;
  durationMs: number;
  /** Truncated stderr+stdout tail from the failing command; empty on pass. */
  output: string;
}

export interface PrepushResult {
  /**
   * True when every ran hook passed OR every hook was skipped. Default true
   * when the flag is off — the caller must not gate on this without also
   * checking `enabled`.
   */
  passed: boolean;
  enabled: boolean;
  results: PrepushHookResult[];
}

/** Returns true when PREPUSH_TESTS_ENABLED is the string "true". */
export function isPrepushEnabled(): boolean {
  return process.env.PREPUSH_TESTS_ENABLED === "true";
}

/**
 * Minimal shape of the container-exec function we need. Typed here rather
 * than re-imported from container-agent.ts to keep the module testable
 * without spinning up a real container.
 */
export interface ContainerExec {
  (command: string, timeoutSeconds: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
}

/**
 * Shape of the fs-read probe used to detect whether the repo has a tsconfig
 * / test script / lint script. Mirrors the /read endpoint of the Go server
 * so we don't hardcode a curl/cat chain.
 */
export interface ContainerReadFile {
  (path: string): Promise<string | null>;
}

export interface RunPrepushArgs {
  sessionId: string;
  exec: ContainerExec;
  readFile: ContainerReadFile;
}

/**
 * Execute every enabled pre-push hook in order (tsc → test → lint). Stops
 * at the first failure so the agent gets a focused error, not a concatenated
 * three-way failure dump that obscures the root cause.
 *
 * Pure function — does not touch the DB. The caller writes telemetry via
 * logPrepushResults() below so this function stays trivial to test.
 */
export async function runPrepushHooks(args: RunPrepushArgs): Promise<PrepushResult> {
  if (!isPrepushEnabled()) {
    return { passed: true, enabled: false, results: [] };
  }

  const results: PrepushHookResult[] = [];

  // Detection probes run once — a single read per file keeps the flag's
  // "off" path at effectively zero cost when we DO enable it.
  const [tsconfig, pkgJsonRaw] = await Promise.all([
    args.readFile("tsconfig.json"),
    args.readFile("package.json"),
  ]);
  const pkgJson = safeParsePackageJson(pkgJsonRaw);
  const hasTestScript = typeof pkgJson.scripts?.test === "string" && pkgJson.scripts.test.trim().length > 0;
  const hasLintScript = typeof pkgJson.scripts?.lint === "string" && pkgJson.scripts.lint.trim().length > 0;

  // ── 1. tsc ──────────────────────────────────────────────────────────────
  if (tsconfig) {
    const tscResult = await runHook(args.exec, "tsc", "npx tsc --noEmit", TSC_TIMEOUT_SEC);
    results.push(tscResult);
    if (tscResult.ran && tscResult.passed === false) {
      return { passed: false, enabled: true, results };
    }
  } else {
    results.push(skippedResult("tsc"));
  }

  // ── 2. npm test ────────────────────────────────────────────────────────
  // Test suites only run when there's BOTH a tsconfig AND a test script —
  // we treat tsconfig as the "this is a typed JS project" signal the spec
  // uses to avoid spawning Python/Ruby/Go test runners under node.
  if (tsconfig && hasTestScript) {
    const testResult = await runHook(args.exec, "test", "npm test --silent", TEST_TIMEOUT_SEC);
    results.push(testResult);
    if (testResult.ran && testResult.passed === false) {
      return { passed: false, enabled: true, results };
    }
  } else {
    results.push(skippedResult("test"));
  }

  // ── 3. npm run lint ────────────────────────────────────────────────────
  if (hasLintScript) {
    const lintResult = await runHook(args.exec, "lint", "npm run lint --silent", LINT_TIMEOUT_SEC);
    results.push(lintResult);
    if (lintResult.ran && lintResult.passed === false) {
      return { passed: false, enabled: true, results };
    }
  } else {
    results.push(skippedResult("lint"));
  }

  return { passed: true, enabled: true, results };
}

async function runHook(
  exec: ContainerExec,
  kind: PrepushKind,
  command: string,
  timeoutSec: number,
): Promise<PrepushHookResult> {
  const start = Date.now();
  try {
    const res = await exec(command, timeoutSec);
    const passed = res.exitCode === 0;
    const tail = passed ? "" : joinOutput(res.stdout, res.stderr);
    return {
      kind,
      ran: true,
      passed,
      exitCode: res.exitCode,
      durationMs: res.durationMs || Date.now() - start,
      output: tail,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind,
      ran: true,
      passed: false,
      exitCode: null,
      durationMs: Date.now() - start,
      output: `Hook exec failed: ${msg}`.slice(0, MAX_HOOK_OUTPUT_CHARS),
    };
  }
}

function skippedResult(kind: PrepushKind): PrepushHookResult {
  return { kind, ran: false, passed: null, exitCode: null, durationMs: 0, output: "" };
}

function joinOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stderr && stderr.trim().length > 0) parts.push(stderr);
  if (stdout && stdout.trim().length > 0) parts.push(stdout);
  return parts.join("\n").slice(-MAX_HOOK_OUTPUT_CHARS);
}

interface ParsedPackageJson {
  scripts?: Record<string, unknown>;
}

function safeParsePackageJson(raw: string | null): ParsedPackageJson {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts = parsed.scripts;
    if (scripts && typeof scripts === "object") {
      return { scripts: scripts as Record<string, unknown> };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Format a pre-push failure as a synthetic tool_result payload the agent
 * can consume on its next turn. Explicit about which hook failed so the
 * model can target its apply_patch retry at the right file / symptom.
 */
export function formatPrepushFeedback(result: PrepushResult): string {
  const failing = result.results.find((r) => r.ran && r.passed === false);
  if (!failing) {
    // Defensive — caller should only invoke this when passed === false.
    return "Pre-push hooks reported a failure but no failing hook was recorded.";
  }
  const kindLabel = LABELS[failing.kind];
  return [
    `Pre-push hook failed: ${kindLabel} (exit ${failing.exitCode ?? "n/a"}, ${failing.durationMs}ms).`,
    "",
    "--- Output (tail) ---",
    failing.output || "(no output captured)",
    "",
    "Fix the failure with apply_patch and then call submit_fix again. Do not call submit_fix until this hook passes.",
  ].join("\n");
}

const LABELS: Record<PrepushKind, string> = {
  tsc: "npx tsc --noEmit",
  test: "npm test",
  lint: "npm run lint",
};

/**
 * True when pre-push ran (flag on), at least one hook actually executed
 * (so we have a real signal — not a degenerate project with no tsconfig
 * and no test/lint scripts), and every executed hook passed. Used by the
 * web's Part C retry logic to distinguish "CI flake after a green local
 * verify" from "CI failed because the code was never locally verified".
 */
export function isPrepushVerified(result: PrepushResult): boolean {
  if (!result.enabled || !result.passed) return false;
  return result.results.some((r) => r.ran && r.passed === true);
}

