/**
 * Fase 4 — pre-push strict hook tests.
 *
 * Covers:
 *   1. Flag-gated no-op when PREPUSH_TESTS_ENABLED is off
 *   2. Skips tsc when no tsconfig.json; skips test/lint when scripts missing
 *   3. Runs tsc → test → lint in order and stops at first failure
 *   4. formatPrepushFeedback produces actionable feedback for the agent
 *   5. Skipped hooks report ran=false with passed=null (distinguishable from pass)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isPrepushEnabled,
  runPrepushHooks,
  formatPrepushFeedback,
  type ContainerExec,
  type ContainerReadFile,
} from "../prepush-hooks.js";

const ORIGINAL_FLAG = process.env.PREPUSH_TESTS_ENABLED;

function stubFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.PREPUSH_TESTS_ENABLED;
  else process.env.PREPUSH_TESTS_ENABLED = value;
}

function makeExec(
  responses: Array<{ match: string | RegExp; exitCode: number; stdout?: string; stderr?: string }>,
): { exec: ContainerExec; calls: string[] } {
  const calls: string[] = [];
  const exec: ContainerExec = async (command, _timeoutSeconds) => {
    calls.push(command);
    const match = responses.find((r) => {
      if (r.match instanceof RegExp) return r.match.test(command);
      return command.includes(r.match);
    });
    if (!match) {
      return { exitCode: 127, stdout: "", stderr: `no stub for "${command}"`, durationMs: 5 };
    }
    return {
      exitCode: match.exitCode,
      stdout: match.stdout ?? "",
      stderr: match.stderr ?? "",
      durationMs: 25,
    };
  };
  return { exec, calls };
}

function makeReadFile(files: Record<string, string | null>): ContainerReadFile {
  return async (path) => {
    return path in files ? files[path] : null;
  };
}

// ── Flag gating ───────────────────────────────────────────────────────────────

describe("isPrepushEnabled", () => {
  beforeEach(() => stubFlag(undefined));
  afterEach(() => stubFlag(ORIGINAL_FLAG));

  it("returns false when unset", () => {
    assert.equal(isPrepushEnabled(), false);
  });

  it("returns false when set to 'false'", () => {
    stubFlag("false");
    assert.equal(isPrepushEnabled(), false);
  });

  it("returns false when set to something-other-than-'true'", () => {
    stubFlag("1");
    assert.equal(isPrepushEnabled(), false);
  });

  it("returns true only for literal 'true'", () => {
    stubFlag("true");
    assert.equal(isPrepushEnabled(), true);
  });
});

describe("runPrepushHooks — flag off", () => {
  beforeEach(() => stubFlag("false"));
  afterEach(() => stubFlag(ORIGINAL_FLAG));

  it("returns enabled:false and passed:true without executing anything", async () => {
    const { exec, calls } = makeExec([]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({ "tsconfig.json": "{}" }),
    });
    assert.equal(result.enabled, false);
    assert.equal(result.passed, true);
    assert.deepEqual(result.results, []);
    assert.equal(calls.length, 0);
  });
});

// ── Detection ────────────────────────────────────────────────────────────────

describe("runPrepushHooks — detection", () => {
  beforeEach(() => stubFlag("true"));
  afterEach(() => stubFlag(ORIGINAL_FLAG));

  it("skips tsc when tsconfig.json is absent", async () => {
    const { exec, calls } = makeExec([]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({ "tsconfig.json": null, "package.json": null }),
    });
    assert.equal(result.enabled, true);
    assert.equal(result.passed, true);
    const tsc = result.results.find((r) => r.kind === "tsc")!;
    assert.equal(tsc.ran, false);
    assert.equal(tsc.passed, null);
    assert.equal(calls.length, 0);
  });

  it("skips npm test when no test script in package.json", async () => {
    const { exec } = makeExec([
      { match: "tsc --noEmit", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ scripts: { start: "node ." } }),
      }),
    });
    const test = result.results.find((r) => r.kind === "test")!;
    assert.equal(test.ran, false);
    assert.equal(test.passed, null);
  });

  it("skips lint when no lint script in package.json", async () => {
    const { exec } = makeExec([
      { match: "tsc --noEmit", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ scripts: { start: "node ." } }),
      }),
    });
    const lint = result.results.find((r) => r.kind === "lint")!;
    assert.equal(lint.ran, false);
    assert.equal(lint.passed, null);
  });

  it("skips npm test when tsconfig is missing, even if test script exists", async () => {
    const { exec } = makeExec([]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": null,
        "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      }),
    });
    const test = result.results.find((r) => r.kind === "test")!;
    assert.equal(test.ran, false);
  });

  it("tolerates malformed package.json without crashing", async () => {
    const { exec } = makeExec([
      { match: "tsc --noEmit", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": "<!not json>",
      }),
    });
    assert.equal(result.enabled, true);
    // No test script parsed → skipped, but tsc still ran.
    const tsc = result.results.find((r) => r.kind === "tsc")!;
    assert.equal(tsc.ran, true);
    assert.equal(tsc.passed, true);
  });
});

// ── Ordering + short-circuit on failure ──────────────────────────────────────

describe("runPrepushHooks — order + short-circuit", () => {
  beforeEach(() => stubFlag("true"));
  afterEach(() => stubFlag(ORIGINAL_FLAG));

  it("runs tsc → test → lint in order when all pass", async () => {
    const { exec, calls } = makeExec([
      { match: "tsc --noEmit", exitCode: 0 },
      { match: "npm test", exitCode: 0 },
      { match: "npm run lint", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
      }),
    });
    assert.equal(result.passed, true);
    assert.equal(calls.length, 3);
    assert.match(calls[0], /tsc --noEmit/);
    assert.match(calls[1], /npm test/);
    assert.match(calls[2], /npm run lint/);
  });

  it("stops at tsc failure — does not run test or lint", async () => {
    const { exec, calls } = makeExec([
      { match: "tsc --noEmit", exitCode: 2, stderr: "src/app.ts(10,5): error TS2339" },
      { match: "npm test", exitCode: 0 },
      { match: "npm run lint", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
      }),
    });
    assert.equal(result.passed, false);
    assert.equal(calls.length, 1);
    const tsc = result.results.find((r) => r.kind === "tsc")!;
    assert.equal(tsc.passed, false);
    assert.ok(tsc.output.includes("TS2339"));
  });

  it("runs tsc then stops at test failure without running lint", async () => {
    const { exec, calls } = makeExec([
      { match: "tsc --noEmit", exitCode: 0 },
      { match: "npm test", exitCode: 1, stdout: "1 test failed", stderr: "" },
      { match: "npm run lint", exitCode: 0 },
    ]);
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({
        "tsconfig.json": "{}",
        "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
      }),
    });
    assert.equal(result.passed, false);
    assert.equal(calls.length, 2);
    const test = result.results.find((r) => r.kind === "test")!;
    assert.equal(test.passed, false);
  });

  it("records exec failure as a failed hook rather than crashing", async () => {
    let callCount = 0;
    const exec: ContainerExec = async () => {
      callCount++;
      throw new Error("container vanished");
    };
    const result = await runPrepushHooks({
      sessionId: "00000000-0000-0000-0000-000000000000",
      exec,
      readFile: makeReadFile({ "tsconfig.json": "{}", "package.json": null }),
    });
    assert.equal(result.passed, false);
    assert.equal(callCount, 1);
    const tsc = result.results.find((r) => r.kind === "tsc")!;
    assert.equal(tsc.passed, false);
    assert.match(tsc.output, /Hook exec failed/);
  });
});

// ── Feedback format ──────────────────────────────────────────────────────────

describe("formatPrepushFeedback", () => {
  it("includes the failing hook command + output tail", () => {
    const feedback = formatPrepushFeedback({
      passed: false,
      enabled: true,
      results: [
        {
          kind: "tsc",
          ran: true,
          passed: false,
          exitCode: 2,
          durationMs: 1234,
          output: "src/app.ts(10,5): error TS2339: Property 'foo' does not exist on type 'Bar'.",
        },
      ],
    });
    assert.match(feedback, /npx tsc --noEmit/);
    assert.match(feedback, /exit 2/);
    assert.match(feedback, /TS2339/);
    assert.match(feedback, /Fix the failure with apply_patch/);
  });

  it("falls back to a defensive message when no failing hook is in results", () => {
    const feedback = formatPrepushFeedback({ passed: false, enabled: true, results: [] });
    assert.match(feedback, /no failing hook was recorded/);
  });
});
