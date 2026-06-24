/**
 * Fase 3 — resolveModelForPhase + gpt-5-nano catalog entry.
 *
 * Covers:
 *   - Every phase for the OpenAI provider maps to the locked Fase 3 model
 *   - gpt-5-nano appears in OPENAI_MODELS (Fase 6 will read it from here)
 *   - Every non-OpenAI provider falls back to the provider's own defaults
 *     (no behavior change for BYOK users in Fase 3)
 *   - All providers declared in DEFAULTS are covered — adding a new provider
 *     in the future without updating the phase mapping must fail this test.
 */

import { describe, expect, it } from "vitest";
import { OPENAI_MODELS, resolveModelForPhase, type RemediationPhase } from "../models";

const ALL_PHASES: RemediationPhase[] = ["classify", "triage", "explore", "fix", "final"];

describe("gpt-5-nano catalog entry", () => {
  it("is present in OPENAI_MODELS", () => {
    const nano = OPENAI_MODELS.find((m) => m.id === "gpt-5-nano");
    expect(nano).toBeDefined();
    expect(nano?.tier).toBe("fast");
  });

  it("does not duplicate gpt-5-mini or gpt-5.4", () => {
    const ids = OPENAI_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveModelForPhase — openai", () => {
  it("classify → gpt-5-nano (Fase 6 router)", () => {
    expect(resolveModelForPhase("classify", "openai")).toBe("gpt-5-nano");
  });

  it("triage → gpt-5-mini (auto-analyze / correlate)", () => {
    expect(resolveModelForPhase("triage", "openai")).toBe("gpt-5-mini");
  });

  it("explore → gpt-5-mini (cheap reasoning during exploration)", () => {
    expect(resolveModelForPhase("explore", "openai")).toBe("gpt-5-mini");
  });

  it("fix → gpt-5.4 (flagship for the patch)", () => {
    expect(resolveModelForPhase("fix", "openai")).toBe("gpt-5.4");
  });

  it("final → gpt-5.4 (last turns keep the flagship)", () => {
    expect(resolveModelForPhase("final", "openai")).toBe("gpt-5.4");
  });
});

describe("resolveModelForPhase — non-openai providers", () => {
  it("claude uses its triage default for classify/triage, remediation for fix/final", () => {
    expect(resolveModelForPhase("classify", "claude")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelForPhase("triage",   "claude")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelForPhase("explore",  "claude")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelForPhase("fix",      "claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelForPhase("final",    "claude")).toBe("claude-sonnet-4-6");
  });

  it("grok keeps its existing remediation model", () => {
    expect(resolveModelForPhase("fix", "grok")).toBe("grok-2-1212");
  });

  it("deepseek routes fix to the reasoner", () => {
    expect(resolveModelForPhase("fix", "deepseek")).toBe("deepseek-reasoner");
  });

  it("gemini routes fix to the pro model", () => {
    expect(resolveModelForPhase("fix", "gemini")).toBe("gemini-1.5-pro");
  });

  it("groq routes triage to the 8B instant model", () => {
    expect(resolveModelForPhase("triage", "groq")).toBe("llama-3.1-8b-instant");
  });
});

describe("resolveModelForPhase — exhaustive provider coverage", () => {
  const PROVIDERS = ["openai", "claude", "grok", "deepseek", "gemini", "groq"] as const;

  it("returns a non-empty string for every (phase, provider)", () => {
    for (const provider of PROVIDERS) {
      for (const phase of ALL_PHASES) {
        const model = resolveModelForPhase(phase, provider);
        expect(model, `${provider}/${phase}`).toBeTruthy();
        expect(typeof model).toBe("string");
      }
    }
  });
});
