// validateKey() tests — v0.3 S2.5.
//
// Stubs global.fetch and asserts each provider returns the right shape on
// 200 / 401 / network error. Hit one OpenAI-compat provider explicitly so
// the shared helper is covered, plus the bespoke Anthropic + Gemini paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateProviderKey } from "../providers";

describe("validateProviderKey()", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("openai — 200 returns valid + modelsAvailable", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;

    const r = await validateProviderKey("openai", "sk-real");
    expect(r.valid).toBe(true);
    expect(r.modelsAvailable).toContain("gpt-4o");
  });

  it("openai — 401 returns invalid + message", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("unauthorized", { status: 401 }),
    ) as typeof globalThis.fetch;

    const r = await validateProviderKey("openai", "sk-bad");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Invalid OpenAI API key/);
  });

  it("openai — network error returns invalid", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;

    const r = await validateProviderKey("openai", "sk-bad");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/network error|ECONNREFUSED/);
  });

  it("claude — 401 surfaces Anthropic-specific message", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as typeof globalThis.fetch;

    const r = await validateProviderKey("claude", "sk-ant-bad");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Invalid Claude API key/);
  });

  it("claude — 200 surfaces models[]", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;

    const r = await validateProviderKey("claude", "sk-ant-real");
    expect(r.valid).toBe(true);
    expect(r.modelsAvailable).toContain("claude-sonnet-4-6");
  });

  it("gemini — 400 returns invalid (Google's auth signal)", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as typeof globalThis.fetch;

    const r = await validateProviderKey("gemini", "AIza-bad");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/Invalid Gemini API key/);
  });

  it("groq + grok + deepseek share the OpenAI-compat path", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "llama-3.1-8b-instant" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;

    for (const p of ["groq", "grok", "deepseek"] as const) {
      const r = await validateProviderKey(p, "key");
      expect(r.valid).toBe(true);
    }
  });

  it("rejects empty keys without making a network call", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;

    const r = await validateProviderKey("openai", "");
    expect(r.valid).toBe(false);
    expect(calls).toBe(0);
  });
});
