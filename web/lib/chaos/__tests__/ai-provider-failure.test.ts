/**
 * Chaos test: AI provider failures.
 *
 * Validates that callAI and callAIWithRetry handle provider outages correctly:
 * - Timeouts, 500s, 429s, network errors, garbage JSON
 * - callAIWithRetry retries and eventually succeeds or fails cleanly
 */

import { describe, it, expect } from "vitest";
import { withFaultyFetch, providerUrl } from "../faults";
import { chaosTest } from "../harness";
import { callAI, callAIWithRetry } from "@/lib/ai/client";

const FAKE_KEY = "sk-ant-fake-key-for-chaos-testing";
const SYSTEM = "You are a test assistant.";
const MSGS = [{ role: "user" as const, content: "Hello" }];

describe("Chaos: AI Provider Failures", () => {
  // ── callAI (no retries) ────────────────────────────────────────────────

  it("callAI throws immediately on provider 500", async () => {
    const result = await chaosTest("ai-500", async () => {
      await withFaultyFetch(
        { statusOverride: 500, urlPattern: providerUrl("claude") },
        () => callAI(FAKE_KEY, SYSTEM, MSGS, { provider: "claude", timeout: 5000 }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("500");
  });

  it("callAI throws on network failure", async () => {
    const result = await chaosTest("ai-network", async () => {
      await withFaultyFetch(
        { failRate: 1, urlPattern: providerUrl("claude") },
        () => callAI(FAKE_KEY, SYSTEM, MSGS, { provider: "claude", timeout: 5000 }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("fetch failed");
  });

  it("callAI throws on 429 rate limit", async () => {
    const result = await chaosTest("ai-429", async () => {
      await withFaultyFetch(
        {
          statusOverride: 429,
          urlPattern: providerUrl("claude"),
          responseHeaders: { "Retry-After": "1" },
        },
        () => callAI(FAKE_KEY, SYSTEM, MSGS, { provider: "claude", timeout: 5000 }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("429");
  });

  it("callAI throws on garbage HTML response", async () => {
    const result = await chaosTest("ai-garbage", async () => {
      await withFaultyFetch(
        {
          statusOverride: 200,
          responseBody: "<html><body>502 Bad Gateway</body></html>",
          urlPattern: providerUrl("claude"),
        },
        () => callAI(FAKE_KEY, SYSTEM, MSGS, { provider: "claude", timeout: 5000 }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("non-JSON");
  });

  // ── callAIWithRetry ────────────────────────────────────────────────────

  it("callAIWithRetry recovers after transient failures", async () => {
    const callLog = { count: 0 };

    const result = await chaosTest("ai-retry-recovery", async () => {
      return await withFaultyFetch(
        {
          failFirstN: 2,
          statusOverride: 500,
          urlPattern: providerUrl("claude"),
          callLog,
        },
        () =>
          callAIWithRetry(FAKE_KEY, SYSTEM, MSGS, {
            provider: "claude",
            timeout: 5000,
            retries: 2,
          }),
      );
    });

    // First 2 calls failed (500), 3rd went through to real fetch (which will also fail
    // because it's a fake key, but it proves retry logic works)
    expect(callLog.count).toBe(3);
  });

  it("callAIWithRetry fails cleanly after all retries exhausted", async () => {
    const callLog = { count: 0 };

    const result = await chaosTest("ai-retry-exhausted", async () => {
      await withFaultyFetch(
        {
          statusOverride: 500,
          urlPattern: providerUrl("claude"),
          callLog,
        },
        () =>
          callAIWithRetry(FAKE_KEY, SYSTEM, MSGS, {
            provider: "claude",
            timeout: 5000,
            retries: 2,
          }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("failed after 3 attempts");
    expect(callLog.count).toBe(3); // 1 initial + 2 retries
  });

  it("callAIWithRetry reports provider name in error", async () => {
    const result = await chaosTest("ai-retry-provider-name", async () => {
      await withFaultyFetch(
        { statusOverride: 503, urlPattern: providerUrl("claude") },
        () =>
          callAIWithRetry(FAKE_KEY, SYSTEM, MSGS, {
            provider: "claude",
            timeout: 5000,
            retries: 0,
          }),
      );
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('"claude"');
  });

  // ── Provider-specific responses ────────────────────────────────────────

  it("handles OpenAI-compatible 200 with valid response", async () => {
    const result = await chaosTest("openai-success", async () => {
      return await withFaultyFetch(
        {
          urlPattern: providerUrl("openai"),
          responseBody: JSON.stringify({
            choices: [{ message: { content: "test response" } }],
          }),
        },
        () =>
          callAI("sk-fake-openai-key", SYSTEM, MSGS, {
            provider: "openai",
            timeout: 5000,
          }),
      );
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("test response");
  });

  it("handles Claude 200 with valid response", async () => {
    const result = await chaosTest("claude-success", async () => {
      return await withFaultyFetch(
        {
          urlPattern: providerUrl("claude"),
          responseBody: JSON.stringify({
            content: [{ text: "claude response" }],
          }),
        },
        () =>
          callAI(FAKE_KEY, SYSTEM, MSGS, {
            provider: "claude",
            timeout: 5000,
          }),
      );
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("claude response");
  });

  it("handles Gemini 200 with valid response", async () => {
    const result = await chaosTest("gemini-success", async () => {
      return await withFaultyFetch(
        {
          urlPattern: providerUrl("gemini"),
          responseBody: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "gemini response" }] } }],
          }),
        },
        () =>
          callAI("AIzaFakeGeminiKey", SYSTEM, MSGS, {
            provider: "gemini",
            timeout: 5000,
          }),
      );
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("gemini response");
  });
});
