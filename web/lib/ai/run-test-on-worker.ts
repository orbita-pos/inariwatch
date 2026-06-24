/**
 * Inari Guard — `runTestOnWorker`
 *
 * Asks the Hetzner worker to actually execute a generated test against
 * the real repo. The worker clones at `ref`, installs deps, writes the
 * test file, runs the framework, and reports pass/fail.
 *
 * This is the OPTIONAL verification pass that runs after the three-pass
 * AI pipeline + static gates. We make it optional because:
 *   - It costs ~60-180s wall time (npm install dominates).
 *   - Worker capacity is bounded (MAX_RUNTEST_CONCURRENT=2 on CX22).
 *   - Some repos (private + no GitHub token configured) can't be cloned.
 *
 * Activated when `WORKER_URL` is set on the cloud env AND the cloud
 * caller passes `verifyOnWorker: true`. Failures are non-fatal — they
 * surface as `verification.error` so the user can see "AI says ready,
 * worker couldn't run it" and decide for themselves.
 */

export interface RunTestOnWorkerArgs {
  sessionId: string;
  repo: string; // "owner/name"
  ref?: string;
  testFiles: Array<{ path: string; content: string }>;
  sourceFile?: { path: string; content: string };
  githubToken?: string;
  timeoutMs?: number;
}

export interface RunTestOnWorkerResult {
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

export interface RunTestOnWorkerFailure {
  error: string;
  code: string;
  detail?: string;
}

/**
 * Returns null when WORKER_URL or STAGING_API_SECRET aren't set —
 * verification is skipped silently and the caller treats this as
 * "no worker available, use static gates only".
 *
 * Throws RunTestOnWorkerFailure-shaped error on worker reachability
 * failures so the caller can decide whether to surface or swallow.
 */
export async function runTestOnWorker(
  args: RunTestOnWorkerArgs,
): Promise<RunTestOnWorkerResult | { failure: RunTestOnWorkerFailure } | null> {
  const url = process.env.WORKER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!url || !secret) return null;

  // Worker timeout is a hint — the worker enforces its own overall
  // deadline. We just need our fetch to NOT hang. Add a 30s buffer
  // over the worker's expected budget.
  const fetchTimeoutMs = (args.timeoutMs ?? 180_000) + 30_000;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/worker/run_test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        sessionId: args.sessionId,
        repo: args.repo,
        ref: args.ref ?? "HEAD",
        testFiles: args.testFiles,
        sourceFile: args.sourceFile,
        githubToken: args.githubToken,
        timeoutMs: args.timeoutMs,
      }),
      signal: controller.signal,
    });

    if (res.status === 200) {
      const body = (await res.json()) as RunTestOnWorkerResult & { sessionId: string };
      return {
        passed: body.passed,
        framework: body.framework,
        testsRun: body.testsRun,
        testsPassed: body.testsPassed,
        testsFailed: body.testsFailed,
        exitCode: body.exitCode,
        durationMs: body.durationMs,
        stdout: body.stdout,
        stderr: body.stderr,
      };
    }

    // 503 capacity / 504 timeout / 400 missing / 422 no framework / 500 internal
    // — all return a typed RunTestError shape.
    const body = (await res.json().catch(() => null)) as RunTestOnWorkerFailure | null;
    return {
      failure: body ?? { error: `worker returned ${res.status}`, code: "unknown" },
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { failure: { error: "worker request timed out", code: "fetch_timeout" } };
    }
    return {
      failure: {
        error: err instanceof Error ? err.message : String(err),
        code: "fetch_failed",
      },
    };
  } finally {
    clearTimeout(abortTimer);
  }
}
