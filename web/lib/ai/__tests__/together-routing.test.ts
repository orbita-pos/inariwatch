/**
 * Tests for the platform-funded Together routing helper.
 *
 * Covers all SEVEN routed task buckets:
 *   CODE      (postmortem/explore)              → Qwen3-Coder-Next
 *   ALERT     (auto-analyze/correlate)          → Qwen3.5-9B
 *   ANALYSIS  (review.security/self, risk.assess) → Qwen3-235B-A22B
 *   FIX       (code.fix.*)                       → Qwen3.6-Plus
 *   CHAT_ORCH (chat.conversational, chat.code)   → Kimi K2.6
 *   CLASSIFY  (intent-classify, alert.classify, code.fingerprint) → gpt-oss-20b
 *   APPLY     (code.apply.diff, notify.compose.*, redact.pii.*)   → Qwen3.5-9B
 * + the flag-gate contract.
 *
 * Model IDs are asserted against the public constants so a typo against
 * Together's serverless catalog (verified 2026-05-14) breaks the test
 * suite, not production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Defensive db mock — `together-routing.ts` transitively pulls in
// `lib/ai/get-key.ts` which imports `@/lib/db` at module-init time.
// Without DATABASE_URL set in the environment the real db client
// throws on creation, taking the suite down before any test runs.
// The mock keeps the file runnable in any environment; the routing
// helper itself doesn't touch the db.
vi.mock("@/lib/db", () => ({
  db:           {},
  projects:     {},
  apiKeys:      {},
  deviceTokens: {},
  users:        {},
}));

import {
  TOGETHER_ALERT_TIER,
  TOGETHER_ASSIST_TIER,
  TOGETHER_GPT_OSS_20B,
  TOGETHER_KIMI_K25,
  TOGETHER_QWEN36_PLUS,
  TOGETHER_QWEN3_FLAGSHIP,
  TOGETHER_QWEN_CODER,
  isTogetherPlatformFundedEnabled,
  modelSupportsThinking,
  resolveTargetForPlatformFunded,
} from "../together-routing";

const FLAG = "INARI_TOGETHER_PLATFORM_FUNDED_ENABLED";

describe("resolveTargetForPlatformFunded", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it("returns null when the flag is unset (default off)", () => {
    expect(resolveTargetForPlatformFunded("postmortem")).toBeNull();
    expect(resolveTargetForPlatformFunded("code.fix.agent-loop")).toBeNull();
  });

  it("returns null when the flag is explicitly off", () => {
    process.env[FLAG] = "false";
    expect(resolveTargetForPlatformFunded("postmortem")).toBeNull();
  });

  // ── CODE bucket (postmortem + explore) ──
  it("routes postmortem to Qwen3-Coder-Next", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("postmortem")).toEqual({
      provider: "together",
      model: TOGETHER_QWEN_CODER,
    });
  });

  it("routes explore phase to Qwen3-Coder-Next", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("explore")).toEqual({
      provider: "together",
      model: TOGETHER_QWEN_CODER,
    });
  });

  // ── ALERT bucket (auto-analyze + correlate) ──
  it("routes alert.auto-analyze to Qwen3.5-9B", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("alert.auto-analyze")).toEqual({
      provider: "together",
      model: TOGETHER_ALERT_TIER,
    });
  });

  it("routes alert.correlate to Qwen3.5-9B", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("alert.correlate")).toEqual({
      provider: "together",
      model: TOGETHER_ALERT_TIER,
    });
  });

  // ── ANALYSIS bucket (review.security/self + risk.assess) ──
  // chat.* tasks moved to CHAT_ORCH on 2026-05-15 — tested separately
  // below. Tasks here are single-turn analytic only.
  it.each([
    "code.review.security",
    "code.review.self",
    "code.risk.assess",
  ])("routes %s to Qwen3-235B flagship", (task) => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded(task)).toEqual({
      provider: "together",
      model: TOGETHER_QWEN3_FLAGSHIP,
    });
  });

  // ── FIX bucket (single-shot + agent-loop + container) ──
  it.each([
    "code.fix",
    "code.fix.single-shot",
    "code.fix.agent-loop",
    "code.fix.container",
  ])("routes %s to Qwen3.6-Plus", (task) => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded(task)).toEqual({
      provider: "together",
      model: TOGETHER_QWEN36_PLUS,
    });
  });

  // ── CHAT_ORCH bucket (chat.conversational + chat.code) ──
  // Multi-turn tool orchestration. Lives on Kimi K2.6 because Qwen3-235B
  // hit silent-tool-call / lost-context regressions on the chat surface.
  // Single-turn analytic chat tasks (review/risk) stayed on Qwen3-235B.
  it.each([
    "chat.conversational",
    "chat.code",
  ])("routes %s to Kimi K2.6", (task) => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded(task)).toEqual({
      provider: "together",
      model: TOGETHER_KIMI_K25,
    });
  });

  // ── CLASSIFY bucket (intent / classify / fingerprint) ──
  it.each([
    "chat.intent-classify",
    "alert.classify",
    "code.fingerprint",
  ])("routes %s to gpt-oss-20b", (task) => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded(task)).toEqual({
      provider: "together",
      model: TOGETHER_GPT_OSS_20B,
    });
  });

  // ── APPLY bucket (diff apply + notify compose + redact PII) ──
  // Routes to the same Qwen3.5-9B as ALERT_ROUTED; semantic-role split
  // exists so a future model swap on either tier doesn't bleed.
  it.each([
    "code.apply.diff",
    "notify.compose.email",
    "notify.compose.slack",
    "notify.compose.telegram",
    "notify.compose.whatsapp",
    "notify.compose.push",
    "notify.compose.digest",
    "notify.compose.status-page",
    "notify.compose.postmortem-prose",
    "redact.pii.breadcrumbs",
    "redact.pii.stacktrace",
  ])("routes %s to Qwen3.5-9B (APPLY tier)", (task) => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded(task)).toEqual({
      provider: "together",
      model: TOGETHER_ALERT_TIER,
    });
  });

  // ── ASSIST bucket (Inari Live pure-slash autocomplete) ──
  // Phase 2 of the pure-slash refactor. Single AI surface in Inari
  // Live's input dropdown — translates natural-language queries into
  // slash command suggestions. Same Qwen3.5-9B weights as ALERT/APPLY
  // but kept distinct so a future cheap swap on this surface (e.g. to
  // gpt-oss-20b) doesn't bleed into the alert pipeline.
  it("routes chat.suggest-command to Qwen3.5-9B (ASSIST tier)", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("chat.suggest-command")).toEqual({
      provider: "together",
      model: TOGETHER_ASSIST_TIER,
    });
  });

  it("ASSIST tier model matches the ALERT/APPLY weights today (Qwen3.5-9B)", () => {
    // Sanity: the three buckets share weights right now. The semantic
    // split lives in the routed-set membership, not the model id. If
    // a future commit repoints ASSIST to gpt-oss-20b, this assertion
    // intentionally fails so the rationale gets reviewed at the same
    // time as the swap.
    expect(TOGETHER_ASSIST_TIER).toBe(TOGETHER_ALERT_TIER);
  });

  it("returns null for non-routed tasks/phases even when flag is on", () => {
    process.env[FLAG] = "true";
    expect(resolveTargetForPlatformFunded("analysis")).toBeNull();
    expect(resolveTargetForPlatformFunded("triage")).toBeNull();
    expect(resolveTargetForPlatformFunded("classify")).toBeNull();
    expect(resolveTargetForPlatformFunded("final")).toBeNull();
    expect(resolveTargetForPlatformFunded("nonexistent.task")).toBeNull();
    // voice.* and gate.* are not platform-funded — caller falls back
    // to BYOK or local. Pin so a future edit doesn't accidentally
    // route them.
    expect(resolveTargetForPlatformFunded("voice.tts.alert")).toBeNull();
    expect(resolveTargetForPlatformFunded("gate.prediction")).toBeNull();
  });

  it("treats truthy non-'true' values as off (strict opt-in)", () => {
    for (const v of ["1", "yes", "TRUE", "True", " true "]) {
      process.env[FLAG] = v;
      expect(resolveTargetForPlatformFunded("postmortem")).toBeNull();
    }
  });
});

describe("isTogetherPlatformFundedEnabled", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it("is false by default", () => {
    expect(isTogetherPlatformFundedEnabled()).toBe(false);
  });

  it("is true only when set to literal 'true'", () => {
    process.env[FLAG] = "true";
    expect(isTogetherPlatformFundedEnabled()).toBe(true);
  });

  it("is false for any other truthy-looking value", () => {
    for (const v of ["1", "yes", "TRUE", " true "]) {
      process.env[FLAG] = v;
      expect(isTogetherPlatformFundedEnabled()).toBe(false);
    }
  });
});

describe("modelSupportsThinking", () => {
  it("matches Qwen3-235B family", () => {
    expect(modelSupportsThinking(TOGETHER_QWEN3_FLAGSHIP)).toBe(true);
    expect(modelSupportsThinking("Qwen/Qwen3-235B-A22B")).toBe(true);
  });

  it("matches Qwen3.6 family", () => {
    expect(modelSupportsThinking(TOGETHER_QWEN36_PLUS)).toBe(true);
  });

  it("matches Qwen3-Coder family", () => {
    expect(modelSupportsThinking(TOGETHER_QWEN_CODER)).toBe(true);
    expect(modelSupportsThinking("Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8")).toBe(true);
  });

  it("does not match the alert tier (Qwen3.5-9B)", () => {
    expect(modelSupportsThinking(TOGETHER_ALERT_TIER)).toBe(false);
  });

  it("does not match non-Qwen models", () => {
    expect(modelSupportsThinking("gpt-5.4")).toBe(false);
    expect(modelSupportsThinking("claude-sonnet-4-6")).toBe(false);
  });

  it("does not match Kimi K2.6 (CHAT_ORCH model)", () => {
    // Kimi K2.6 is a thinking agent but doesn't accept Together's
    // Qwen-specific `enable_thinking` chat_template_kwargs flag.
    // Sending it would be a no-op at best, malformed payload at worst.
    expect(modelSupportsThinking(TOGETHER_KIMI_K25)).toBe(false);
  });

  it("does not match gpt-oss-20b (CLASSIFY model)", () => {
    expect(modelSupportsThinking(TOGETHER_GPT_OSS_20B)).toBe(false);
  });
});
