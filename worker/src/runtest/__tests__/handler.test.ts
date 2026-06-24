/**
 * Unit tests for the run_test worker handler's pure helpers.
 *
 * Run: cd worker && npx tsx --test src/runtest/__tests__/handler.test.ts
 *
 * We don't exercise the full `runTest()` flow here — that needs git +
 * npm + a real repo. The integration test sits inside the cloud route
 * (the web side calls the worker over HTTP and asserts the shape).
 *
 * What we cover here:
 *   - detectFramework() — every supported runner + the script-only fallback
 *   - buildRunnerArgs() — every supported runner produces the right argv
 *   - parseRunnerCounts() — passing + failing output for each runner
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFramework, buildRunnerArgs, parseRunnerCounts } from "../handler.js";

// ── detectFramework ────────────────────────────────────────────────────────

test("detectFramework: vitest in devDependencies", () => {
  assert.equal(detectFramework({ devDependencies: { vitest: "^2.0.0" } }), "vitest");
});

test("detectFramework: jest in dependencies", () => {
  assert.equal(detectFramework({ dependencies: { jest: "^29.0.0" } }), "jest");
});

test("detectFramework: @jest/core is jest", () => {
  assert.equal(detectFramework({ devDependencies: { "@jest/core": "^29.0.0" } }), "jest");
});

test("detectFramework: @playwright/test", () => {
  assert.equal(detectFramework({ devDependencies: { "@playwright/test": "^1.0.0" } }), "playwright");
});

test("detectFramework: mocha", () => {
  assert.equal(detectFramework({ devDependencies: { mocha: "^10.0.0" } }), "mocha");
});

test("detectFramework: vitest beats jest when both present", () => {
  assert.equal(
    detectFramework({ devDependencies: { vitest: "^2.0.0", jest: "^29.0.0" } }),
    "vitest",
  );
});

test("detectFramework: fallback to scripts.test", () => {
  assert.equal(detectFramework({ scripts: { test: "vitest run" } }), "vitest");
  assert.equal(detectFramework({ scripts: { test: "jest --ci" } }), "jest");
  assert.equal(detectFramework({ scripts: { test: "playwright test" } }), "playwright");
  assert.equal(detectFramework({ scripts: { test: "mocha --reporter dot" } }), "mocha");
});

test("detectFramework: returns null when nothing matches", () => {
  assert.equal(detectFramework({}), null);
  assert.equal(detectFramework({ scripts: { test: "tap" } }), null);
  assert.equal(detectFramework({ devDependencies: { lodash: "^4.0.0" } }), null);
});

// ── buildRunnerArgs ────────────────────────────────────────────────────────

test("buildRunnerArgs: vitest", () => {
  assert.deepEqual(buildRunnerArgs("vitest", ["src/auth.test.ts"]), [
    "npx",
    "--no-install",
    "vitest",
    "run",
    "--reporter=verbose",
    "src/auth.test.ts",
  ]);
});

test("buildRunnerArgs: jest", () => {
  assert.deepEqual(buildRunnerArgs("jest", ["src/auth.test.ts"]), [
    "npx",
    "--no-install",
    "jest",
    "--colors=false",
    "src/auth.test.ts",
  ]);
});

test("buildRunnerArgs: playwright", () => {
  assert.deepEqual(buildRunnerArgs("playwright", ["src/auth.test.ts"]), [
    "npx",
    "--no-install",
    "playwright",
    "test",
    "src/auth.test.ts",
  ]);
});

test("buildRunnerArgs: mocha", () => {
  assert.deepEqual(buildRunnerArgs("mocha", ["src/auth.test.ts"]), [
    "npx",
    "--no-install",
    "mocha",
    "--reporter=spec",
    "src/auth.test.ts",
  ]);
});

test("buildRunnerArgs: handles multiple test paths", () => {
  const args = buildRunnerArgs("vitest", ["a.test.ts", "b.test.ts"]);
  assert.ok(args.includes("a.test.ts"));
  assert.ok(args.includes("b.test.ts"));
});

// ── parseRunnerCounts ──────────────────────────────────────────────────────

test("parseRunnerCounts: vitest all-pass", () => {
  const out = " Test Files  1 passed (1)\n Tests   3 passed (3)";
  assert.deepEqual(parseRunnerCounts("vitest", out, ""), { run: 3, passed: 3, failed: 0 });
});

test("parseRunnerCounts: vitest mixed", () => {
  const out = " Tests   2 passed | 1 failed (3)";
  assert.deepEqual(parseRunnerCounts("vitest", out, ""), { run: 3, passed: 2, failed: 1 });
});

test("parseRunnerCounts: vitest unrecognised → zeros", () => {
  assert.deepEqual(parseRunnerCounts("vitest", "no match", ""), { run: 0, passed: 0, failed: 0 });
});

test("parseRunnerCounts: jest all-pass", () => {
  const out = "Tests:       3 passed, 3 total";
  assert.deepEqual(parseRunnerCounts("jest", out, ""), { run: 3, passed: 3, failed: 0 });
});

test("parseRunnerCounts: jest mixed", () => {
  const out = "Tests:       1 failed, 2 passed, 3 total";
  assert.deepEqual(parseRunnerCounts("jest", out, ""), { run: 3, passed: 2, failed: 1 });
});

test("parseRunnerCounts: playwright passing", () => {
  const out = " 3 passed (5s)";
  assert.deepEqual(parseRunnerCounts("playwright", out, ""), { run: 3, passed: 3, failed: 0 });
});

test("parseRunnerCounts: playwright failing", () => {
  const out = " 2 passed (5s)\n 1 failed";
  assert.deepEqual(parseRunnerCounts("playwright", out, ""), { run: 3, passed: 2, failed: 1 });
});

test("parseRunnerCounts: mocha passing", () => {
  const out = "  3 passing (5ms)";
  assert.deepEqual(parseRunnerCounts("mocha", out, ""), { run: 3, passed: 3, failed: 0 });
});

test("parseRunnerCounts: mocha failing", () => {
  const out = "  2 passing\n  1 failing";
  assert.deepEqual(parseRunnerCounts("mocha", out, ""), { run: 3, passed: 2, failed: 1 });
});

test("parseRunnerCounts: unknown framework → zeros", () => {
  assert.deepEqual(parseRunnerCounts("foobar", "anything", ""), { run: 0, passed: 0, failed: 0 });
});
