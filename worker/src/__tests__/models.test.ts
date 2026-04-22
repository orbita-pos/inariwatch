/**
 * Fase 3 — worker-side resolveModelForPhase + effortForPhase.
 * Mirror of web/lib/ai/__tests__/models-phase.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveModelForPhase, effortForPhase, type RemediationPhase } from "../models.js";

const ALL_PHASES: RemediationPhase[] = ["classify", "triage", "explore", "fix", "final"];

describe("resolveModelForPhase — openai", () => {
  it("classify → gpt-5-nano", () => {
    assert.equal(resolveModelForPhase("classify", "openai"), "gpt-5-nano");
  });

  it("triage → gpt-5-mini", () => {
    assert.equal(resolveModelForPhase("triage", "openai"), "gpt-5-mini");
  });

  it("explore → gpt-5-mini", () => {
    assert.equal(resolveModelForPhase("explore", "openai"), "gpt-5-mini");
  });

  it("fix → gpt-5.4", () => {
    assert.equal(resolveModelForPhase("fix", "openai"), "gpt-5.4");
  });

  it("final → gpt-5.4", () => {
    assert.equal(resolveModelForPhase("final", "openai"), "gpt-5.4");
  });
});

describe("resolveModelForPhase — non-openai providers", () => {
  it("returns null for claude (caller keeps BYOK model)", () => {
    for (const phase of ALL_PHASES) {
      assert.equal(resolveModelForPhase(phase, "claude"), null, `claude/${phase}`);
    }
  });

  it("returns null for grok / deepseek / gemini / groq", () => {
    for (const provider of ["grok", "deepseek", "gemini", "groq"] as const) {
      for (const phase of ALL_PHASES) {
        assert.equal(resolveModelForPhase(phase, provider), null, `${provider}/${phase}`);
      }
    }
  });
});

describe("effortForPhase", () => {
  it("classify + triage → minimal", () => {
    assert.equal(effortForPhase("classify"), "minimal");
    assert.equal(effortForPhase("triage"), "minimal");
  });

  it("explore → low", () => {
    assert.equal(effortForPhase("explore"), "low");
  });

  it("fix → medium", () => {
    assert.equal(effortForPhase("fix"), "medium");
  });

  it("final → high", () => {
    assert.equal(effortForPhase("final"), "high");
  });
});
