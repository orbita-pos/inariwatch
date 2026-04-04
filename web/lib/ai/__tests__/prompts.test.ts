/**
 * Tests for AI prompt builders.
 *
 * Validates structure, truncation, and section inclusion — the contract
 * between the remediation engine and the AI models.
 */

import { describe, it, expect } from "vitest";
import {
  buildAnalyzePrompt,
  buildCorrelatePrompt,
  buildPredictionPrompt,
  buildDiagnosePrompt,
  buildFixPrompt,
  buildSelfReviewPrompt,
  buildTestPrompt,
  SYSTEM_ANALYZER,
  SYSTEM_CORRELATOR,
  SYSTEM_REMEDIATOR,
  SYSTEM_REVIEWER,
  SYSTEM_PREDICTOR,
  SYSTEM_TEST_GENERATOR,
  type RemediationContext,
  type MemoryHint,
} from "../prompts";

// ── System prompts ──────────────────────────────────────────────────────────

describe("System prompts", () => {
  it("SYSTEM_ANALYZER is non-empty", () => {
    expect(SYSTEM_ANALYZER.length).toBeGreaterThan(50);
  });

  it("SYSTEM_REMEDIATOR includes JSON-only rule", () => {
    expect(SYSTEM_REMEDIATOR).toContain("valid JSON");
  });

  it("SYSTEM_REVIEWER includes scoring guidance", () => {
    expect(SYSTEM_REVIEWER).toContain("approve");
    expect(SYSTEM_REVIEWER).toContain("strict");
  });

  it("SYSTEM_PREDICTOR includes JSON schema", () => {
    expect(SYSTEM_PREDICTOR).toContain("predictions");
    expect(SYSTEM_PREDICTOR).toContain("overallRisk");
  });

  it("SYSTEM_TEST_GENERATOR enforces regression test pattern", () => {
    expect(SYSTEM_TEST_GENERATOR).toContain("Reproduce the exact bug");
  });
});

// ── buildAnalyzePrompt ──────────────────────────────────────────────────────

describe("buildAnalyzePrompt", () => {
  const alert = {
    title: "TypeError: Cannot read property 'id' of null",
    severity: "critical",
    body: "Stack trace: at getUser (src/auth.ts:42)",
    sourceIntegrations: ["sentry", "vercel"],
  };

  it("includes alert title", () => {
    const prompt = buildAnalyzePrompt(alert);
    expect(prompt).toContain(alert.title);
  });

  it("includes severity", () => {
    const prompt = buildAnalyzePrompt(alert);
    expect(prompt).toContain("critical");
  });

  it("includes sources joined", () => {
    const prompt = buildAnalyzePrompt(alert);
    expect(prompt).toContain("sentry, vercel");
  });

  it("truncates body to 1000 chars", () => {
    const longBody = "x".repeat(2000);
    const prompt = buildAnalyzePrompt({ ...alert, body: longBody });
    // The body slice is 1000, so prompt should not contain the full 2000 chars
    expect(prompt.length).toBeLessThan(longBody.length);
  });

  it("requests structured response", () => {
    const prompt = buildAnalyzePrompt(alert);
    expect(prompt).toContain("Root cause");
    expect(prompt).toContain("Remediation");
  });
});

// ── buildCorrelatePrompt ────────────────────────────────────────────────────

describe("buildCorrelatePrompt", () => {
  const alerts = [
    { title: "DB connection timeout", severity: "critical", source: ["sentry"], createdAt: "2026-04-01T10:00:00Z" },
    { title: "API latency spike", severity: "warning", source: ["datadog"], createdAt: "2026-04-01T10:01:00Z" },
  ];

  it("includes all alerts", () => {
    const prompt = buildCorrelatePrompt(alerts);
    expect(prompt).toContain("DB connection timeout");
    expect(prompt).toContain("API latency spike");
  });

  it("includes alert count", () => {
    const prompt = buildCorrelatePrompt(alerts);
    expect(prompt).toContain("2 alerts");
  });

  it("includes severity in uppercase", () => {
    const prompt = buildCorrelatePrompt(alerts);
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("WARNING");
  });

  it("numbers alerts sequentially", () => {
    const prompt = buildCorrelatePrompt(alerts);
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });
});

// ── buildPredictionPrompt ───────────────────────────────────────────────────

describe("buildPredictionPrompt", () => {
  const diff = "- old line\n+ new line";
  const files = [
    { filename: "src/api.ts", additions: 10, deletions: 5 },
    { filename: "src/db.ts", additions: 3, deletions: 1 },
  ];
  const recentAlerts = [
    { title: "Null reference in api.ts", severity: "critical", aiReasoning: "Missing null check on user object" },
  ];
  const patterns = [
    { patternText: "TypeError: Cannot read property", category: "null_reference", occurrenceCount: 47, topFix: "Add null check" },
  ];

  it("includes file list with +/- counts", () => {
    const prompt = buildPredictionPrompt(diff, files, recentAlerts, patterns, null);
    expect(prompt).toContain("src/api.ts (+10/-5)");
    expect(prompt).toContain("src/db.ts (+3/-1)");
  });

  it("includes diff", () => {
    const prompt = buildPredictionPrompt(diff, files, recentAlerts, patterns, null);
    expect(prompt).toContain("+ new line");
  });

  it("truncates diff at 6000 chars", () => {
    const longDiff = "x".repeat(7000);
    const prompt = buildPredictionPrompt(longDiff, files, [], [], null);
    expect(prompt).toContain("...(truncated)");
    expect(prompt).not.toContain("x".repeat(7000));
  });

  it("includes recent alerts", () => {
    const prompt = buildPredictionPrompt(diff, files, recentAlerts, patterns, null);
    expect(prompt).toContain("Null reference in api.ts");
    expect(prompt).toContain("Missing null check");
  });

  it("shows 'No recent alerts' when empty", () => {
    const prompt = buildPredictionPrompt(diff, files, [], patterns, null);
    expect(prompt).toContain("No recent alerts");
  });

  it("includes community patterns with team count", () => {
    const prompt = buildPredictionPrompt(diff, files, recentAlerts, patterns, null);
    expect(prompt).toContain("47 teams");
    expect(prompt).toContain("Add null check");
  });

  it("shows 'No matching community patterns' when empty", () => {
    const prompt = buildPredictionPrompt(diff, files, [], [], null);
    expect(prompt).toContain("No matching community patterns");
  });

  it("includes substrate context when provided", () => {
    const prompt = buildPredictionPrompt(diff, files, [], [], "HTTP GET /api/users → 500");
    expect(prompt).toContain("Substrate I/O Context");
    expect(prompt).toContain("HTTP GET /api/users");
  });

  it("excludes substrate section when null", () => {
    const prompt = buildPredictionPrompt(diff, files, [], [], null);
    expect(prompt).not.toContain("Substrate I/O Context");
  });

  it("sums team count across patterns", () => {
    const multiPatterns = [
      { patternText: "Error A", category: "runtime", occurrenceCount: 10, topFix: null },
      { patternText: "Error B", category: "build", occurrenceCount: 20, topFix: null },
    ];
    const prompt = buildPredictionPrompt(diff, files, [], multiPatterns, null);
    expect(prompt).toContain("30 teams");
  });
});

// ── buildDiagnosePrompt ─────────────────────────────────────────────────────

describe("buildDiagnosePrompt", () => {
  const alert = {
    title: "Build failed",
    body: "Error: Module not found: 'react'",
    sourceIntegrations: ["vercel"],
  };
  const repoFiles = [
    "src/index.ts",
    "src/App.tsx",
    "node_modules/react/index.js",
    ".git/config",
    "package-lock.json",
  ];

  it("includes alert title and details", () => {
    const prompt = buildDiagnosePrompt(alert, repoFiles);
    expect(prompt).toContain("Build failed");
    expect(prompt).toContain("Module not found");
  });

  it("filters node_modules and .git from file tree", () => {
    const prompt = buildDiagnosePrompt(alert, repoFiles);
    expect(prompt).not.toContain("node_modules/react");
    expect(prompt).not.toContain(".git/config");
  });

  it("filters files containing .lock from file tree", () => {
    // The filter checks for ".lock" substring, which matches yarn.lock etc.
    // package-lock.json does NOT contain ".lock" as a standalone segment — it passes the filter.
    const prompt = buildDiagnosePrompt(alert, repoFiles);
    // package-lock.json is NOT filtered by the ".lock" check (it contains "-lock." not ".lock")
    expect(prompt).toContain("package-lock.json");
    // But yarn.lock IS filtered
    const withYarn = [...repoFiles, "yarn.lock"];
    const prompt2 = buildDiagnosePrompt(alert, withYarn);
    expect(prompt2).not.toContain("yarn.lock");
  });

  it("annotates hot files", () => {
    const hotFiles = new Map([["src/App.tsx", 5]]);
    const prompt = buildDiagnosePrompt(alert, repoFiles, null, undefined, hotFiles);
    expect(prompt).toContain("[HOT:5 fixes]");
  });

  it("does not annotate files with < 2 fixes", () => {
    const hotFiles = new Map([["src/App.tsx", 1]]);
    const prompt = buildDiagnosePrompt(alert, repoFiles, null, undefined, hotFiles);
    expect(prompt).not.toContain("[HOT:");
  });

  it("annotates deployed files", () => {
    const prompt = buildDiagnosePrompt(alert, repoFiles, null, undefined, undefined, ["src/index.ts"]);
    expect(prompt).toContain("[DEPLOYED]");
  });

  it("includes Sentry context when provided", () => {
    const context: RemediationContext = {
      sentryStackTrace: "at getUser (src/auth.ts:42)\nat handler (src/api.ts:10)",
      sentryIssueDetails: null,
      vercelBuildLogs: null,
      githubCILogs: null,
      datadogMetrics: null,
      substrateContext: null,
      eapReceipt: null,
      deployContext: null,
      codebaseContext: null,
      fixReplayContext: null,
    };
    const prompt = buildDiagnosePrompt(alert, repoFiles, context);
    expect(prompt).toContain("SENTRY STACK TRACE");
    expect(prompt).toContain("getUser");
  });

  it("includes multiple context sections", () => {
    const context: RemediationContext = {
      sentryStackTrace: "trace here",
      sentryIssueDetails: null,
      vercelBuildLogs: "Build error: TS2304",
      githubCILogs: "npm test failed",
      datadogMetrics: null,
      substrateContext: null,
      eapReceipt: null,
      deployContext: "Files changed: src/api.ts",
      codebaseContext: null,
      fixReplayContext: null,
    };
    const prompt = buildDiagnosePrompt(alert, repoFiles, context);
    expect(prompt).toContain("SENTRY STACK TRACE");
    expect(prompt).toContain("VERCEL BUILD LOGS");
    expect(prompt).toContain("GITHUB CI LOGS");
    expect(prompt).toContain("RECENT DEPLOY");
  });

  it("includes past incidents as memory hints", () => {
    const pastIncidents: MemoryHint[] = [{
      alertTitle: "Same build error",
      rootCause: "Missing dependency",
      fixSummary: "Added react to package.json",
      filesFixed: ["package.json"],
      confidence: 90,
    }];
    const prompt = buildDiagnosePrompt(alert, repoFiles, null, pastIncidents);
    expect(prompt).toContain("SIMILAR PAST INCIDENTS");
    expect(prompt).toContain("Missing dependency");
    expect(prompt).toContain("package.json");
  });

  it("includes confidence scoring guide", () => {
    const prompt = buildDiagnosePrompt(alert, repoFiles);
    expect(prompt).toContain("90-100:");
    expect(prompt).toContain("0-29:");
  });

  it("includes previous AI reasoning when available", () => {
    const alertWithReasoning = { ...alert, aiReasoning: "Likely a missing import" };
    const prompt = buildDiagnosePrompt(alertWithReasoning, repoFiles);
    expect(prompt).toContain("Previous AI analysis");
    expect(prompt).toContain("Likely a missing import");
  });

  it("limits file tree to 500 entries", () => {
    const manyFiles = Array.from({ length: 600 }, (_, i) => `src/file${i}.ts`);
    const prompt = buildDiagnosePrompt(alert, manyFiles);
    // Should only contain 500 files
    expect(prompt).toContain("src/file499.ts");
    expect(prompt).not.toContain("src/file500.ts");
  });
});

// ── buildFixPrompt ──────────────────────────────────────────────────────────

describe("buildFixPrompt", () => {
  const diagnosis = "Missing null check on user object";
  const files = [{ path: "src/auth.ts", content: "const id = user.id;" }];
  const errorDetails = "TypeError: Cannot read property 'id' of null";

  it("includes diagnosis", () => {
    const prompt = buildFixPrompt(diagnosis, files, errorDetails);
    expect(prompt).toContain("Missing null check");
  });

  it("includes file content with path header", () => {
    const prompt = buildFixPrompt(diagnosis, files, errorDetails);
    expect(prompt).toContain("--- src/auth.ts ---");
    expect(prompt).toContain("const id = user.id;");
  });

  it("truncates file content at 10000 chars", () => {
    const longFile = [{ path: "big.ts", content: "x".repeat(12000) }];
    const prompt = buildFixPrompt(diagnosis, longFile, errorDetails);
    expect(prompt).not.toContain("x".repeat(12000));
  });

  it("truncates error details at 2000 chars", () => {
    const longError = "e".repeat(3000);
    const prompt = buildFixPrompt(diagnosis, files, longError);
    expect(prompt).not.toContain("e".repeat(3000));
  });

  it("includes retry context when previous attempt provided", () => {
    const prev = {
      files: [{ path: "src/auth.ts", content: "attempted fix" }],
      ciError: "TypeError still occurring",
    };
    const prompt = buildFixPrompt(diagnosis, files, errorDetails, prev);
    expect(prompt).toContain("PREVIOUS FIX ATTEMPT FAILED");
    expect(prompt).toContain("TypeError still occurring");
    expect(prompt).toContain("DIFFERENT approach");
  });

  it("excludes retry context when no previous attempt", () => {
    const prompt = buildFixPrompt(diagnosis, files, errorDetails);
    expect(prompt).not.toContain("PREVIOUS FIX ATTEMPT");
  });

  it("includes codebase context when provided", () => {
    const prompt = buildFixPrompt(diagnosis, files, errorDetails, undefined, "Uses Zod for validation");
    expect(prompt).toContain("CODEBASE PATTERNS");
    expect(prompt).toContain("Zod for validation");
  });

  it("requests JSON response format", () => {
    const prompt = buildFixPrompt(diagnosis, files, errorDetails);
    expect(prompt).toContain('"explanation"');
    expect(prompt).toContain('"files"');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"content"');
  });
});

// ── buildSelfReviewPrompt ───────────────────────────────────────────────────

describe("buildSelfReviewPrompt", () => {
  const diagnosis = "Null reference in auth handler";
  const original = [{ path: "src/auth.ts", content: "const id = user.id;" }];
  const fixed = [{ path: "src/auth.ts", content: "const id = user?.id;" }];
  const errorDetails = "TypeError at auth.ts:42";

  it("includes diff with original and fixed labels", () => {
    const prompt = buildSelfReviewPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain("--- src/auth.ts (original) ---");
    expect(prompt).toContain("+++ src/auth.ts (fixed) ---");
  });

  it("shows (new file) when no original exists", () => {
    const newFile = [{ path: "src/helper.ts", content: "export function helper() {}" }];
    const prompt = buildSelfReviewPrompt(diagnosis, [], newFile, errorDetails);
    expect(prompt).toContain("(new file)");
  });

  it("includes scoring guide", () => {
    const prompt = buildSelfReviewPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain("90-100:");
    expect(prompt).toContain("0-59:");
  });

  it("requests JSON response with score and recommendation", () => {
    const prompt = buildSelfReviewPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain('"score"');
    expect(prompt).toContain('"recommendation"');
    expect(prompt).toContain('"concerns"');
  });
});

// ── buildTestPrompt ─────────────────────────────────────────────────────────

describe("buildTestPrompt", () => {
  const diagnosis = "Missing null check";
  const original = [{ path: "src/auth.ts", content: "old code" }];
  const fixed = [{ path: "src/auth.ts", content: "new code" }];
  const errorDetails = "TypeError at auth.ts";

  it("includes fix summary", () => {
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain("--- src/auth.ts ---");
    expect(prompt).toContain("new code");
  });

  it("includes existing test conventions when provided", () => {
    const existingTests = [{ path: "src/__tests__/utils.test.ts", content: "import { describe } from 'vitest'" }];
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails, existingTests);
    expect(prompt).toContain("EXISTING TEST CONVENTIONS");
    expect(prompt).toContain("vitest");
  });

  it("excludes test conventions section when no tests provided", () => {
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).not.toContain("EXISTING TEST CONVENTIONS");
  });

  it("includes codebase context when provided", () => {
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails, undefined, "Jest config: moduleNameMapper");
    expect(prompt).toContain("CODEBASE PATTERNS");
    expect(prompt).toContain("moduleNameMapper");
  });

  it("requests JSON response with files array", () => {
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain('"files"');
    expect(prompt).toContain('"description"');
  });

  it("enforces regression test principle", () => {
    const prompt = buildTestPrompt(diagnosis, original, fixed, errorDetails);
    expect(prompt).toContain("MUST fail if the fix is reverted");
  });
});
