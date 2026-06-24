import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const callAIMock = vi.fn();

vi.mock("@/lib/db", () => ({}));

vi.mock("../client", () => ({
  callAI: (...args: unknown[]) => callAIMock(...args),
}));

vi.mock("../models", () => ({
  resolveModelForPhase: () => "gpt-5-mini",
}));

// Import AFTER mocks
import {
  generateHypotheses,
  parseEnvelope,
  MIN_HYPOTHESES,
  MAX_HYPOTHESES,
  HYPOTHESIS_FIELD_LIMIT,
} from "../hypothesis-generator";

const sess = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  alertId: "00000000-0000-0000-0000-000000000003",
  userId: "00000000-0000-0000-0000-000000000004",
};

const input = {
  alertTitle: "TypeError: Cannot read properties of undefined",
  alertBody: "at renderItem (src/components/List.tsx:42:15)",
  diagnosis: "user.profile is undefined when the feed renders for anonymous users",
};

beforeEach(() => {
  callAIMock.mockReset();
  process.env.PLATFORM_AI_KEY = "test-key";
  delete process.env.HYPOTHESIS_GEN_ENABLED;
});

afterEach(() => {
  delete process.env.PLATFORM_AI_KEY;
  delete process.env.HYPOTHESIS_GEN_ENABLED;
});

// ── parseEnvelope ──────────────────────────────────────────────────────────

describe("parseEnvelope", () => {
  it("returns normalized hypotheses on well-formed input", () => {
    const raw = JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "null user", scope_glob: "src/feed/**/*.ts", reasoning: "anon path", confidence: 70 },
        { id: "h2", diagnosis: "race on profile fetch", scope_glob: null, reasoning: "SSR hydration", confidence: 50 },
        { id: "h3", diagnosis: "missing import", scope_glob: "src/components/List.tsx", reasoning: "ts error shape", confidence: 30 },
      ],
    });
    const out = parseEnvelope(raw);
    expect(out).toHaveLength(3);
    expect(out?.[0].id).toBe("h1");
    expect(out?.[0].confidence).toBe(70);
    expect(out?.[0].scopeGlob).toBe("src/feed/**/*.ts");
    expect(out?.[1].scopeGlob).toBeNull();
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "a", reasoning: "b", confidence: 50 },
        { id: "h2", diagnosis: "c", reasoning: "d", confidence: 40 },
      ],
    }) + "\n```";
    const out = parseEnvelope(raw);
    expect(out).toHaveLength(2);
  });

  it("returns null for invalid JSON", () => {
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
  });

  it("returns null when fewer than MIN_HYPOTHESES valid entries", () => {
    const raw = JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "a", reasoning: "b", confidence: 50 },
      ],
    });
    expect(parseEnvelope(raw)).toBeNull();
  });

  it("clips at MAX_HYPOTHESES", () => {
    const raw = JSON.stringify({
      hypotheses: Array.from({ length: MAX_HYPOTHESES + 3 }, (_, i) => ({
        id: `h${i}`, diagnosis: `d${i}`, reasoning: `r${i}`, confidence: 50,
      })),
    });
    const out = parseEnvelope(raw);
    expect(out).toHaveLength(MAX_HYPOTHESES);
  });

  it("drops entries with missing fields", () => {
    const raw = JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "a", reasoning: "b", confidence: 50 },
        { id: "h2", diagnosis: "", reasoning: "r", confidence: 50 },          // drop
        { id: "h3", diagnosis: "c", reasoning: "", confidence: 50 },          // drop
        { diagnosis: "d", reasoning: "r", confidence: 50 },                   // drop (no id)
        { id: "h4", diagnosis: "d", reasoning: "r", confidence: 50 },
      ],
    });
    const out = parseEnvelope(raw);
    expect(out).toHaveLength(2);
    expect(out?.map((h) => h.id)).toEqual(["h1", "h4"]);
  });

  it("clamps confidence to 0-100 and defaults non-numeric to 50", () => {
    const raw = JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "a", reasoning: "b", confidence: 150 },
        { id: "h2", diagnosis: "c", reasoning: "d", confidence: -20 },
        { id: "h3", diagnosis: "e", reasoning: "f", confidence: "not a number" },
      ],
    });
    const out = parseEnvelope(raw);
    expect(out?.[0].confidence).toBe(100);
    expect(out?.[1].confidence).toBe(0);
    expect(out?.[2].confidence).toBe(50);
  });

  it("trims oversized diagnosis / reasoning to HYPOTHESIS_FIELD_LIMIT", () => {
    const huge = "A".repeat(HYPOTHESIS_FIELD_LIMIT + 500);
    const raw = JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: huge, reasoning: huge, confidence: 50 },
        { id: "h2", diagnosis: huge, reasoning: huge, confidence: 50 },
      ],
    });
    const out = parseEnvelope(raw);
    expect(out?.[0].diagnosis.length).toBe(HYPOTHESIS_FIELD_LIMIT);
    expect(out?.[0].reasoning.length).toBe(HYPOTHESIS_FIELD_LIMIT);
  });

  it("accepts a JSON blob surrounded by prose / whitespace", () => {
    const raw = `Sure, here you go:\n\n{"hypotheses": [${[
      JSON.stringify({ id: "h1", diagnosis: "a", reasoning: "b", confidence: 50 }),
      JSON.stringify({ id: "h2", diagnosis: "c", reasoning: "d", confidence: 40 }),
    ].join(", ")}]}\n\nLet me know if you want more.`;
    const out = parseEnvelope(raw);
    expect(out).toHaveLength(2);
  });
});

// ── generateHypotheses ─────────────────────────────────────────────────────

describe("generateHypotheses", () => {
  it("returns ok with parsed hypotheses on happy path", async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      hypotheses: [
        { id: "h1", diagnosis: "null user", scope_glob: "src/feed/**", reasoning: "anon", confidence: 70 },
        { id: "h2", diagnosis: "race on profile fetch", scope_glob: null, reasoning: "hydration", confidence: 50 },
        { id: "h3", diagnosis: "missing import", scope_glob: null, reasoning: "tsc shape", confidence: 30 },
      ],
    }));
    const out = await generateHypotheses(sess, input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.hypotheses).toHaveLength(3);
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns skipped=no_api_key when neither PLATFORM_AI_KEY nor OPENAI_API_KEY is set", async () => {
    delete process.env.PLATFORM_AI_KEY;
    delete process.env.OPENAI_API_KEY;
    const out = await generateHypotheses(sess, input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("no_api_key");
  });

  it("returns skipped=disabled when HYPOTHESIS_GEN_ENABLED=false", async () => {
    process.env.HYPOTHESIS_GEN_ENABLED = "false";
    const out = await generateHypotheses(sess, input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("disabled");
    expect(callAIMock).not.toHaveBeenCalled();
  });

  it("returns skipped=model_error when callAI throws", async () => {
    callAIMock.mockRejectedValueOnce(new Error("upstream 500"));
    const out = await generateHypotheses(sess, input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("model_error");
  });

  it("returns skipped=malformed_output when the model emits garbage", async () => {
    callAIMock.mockResolvedValueOnce("not json at all");
    const out = await generateHypotheses(sess, input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.skipped).toBe("malformed_output");
  });

  it("passes feature=remediation + phase=hypothesis + modelTier=mini to callAI.log", async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      hypotheses: Array.from({ length: 3 }, (_, i) => ({
        id: `h${i}`, diagnosis: "d", reasoning: "r", confidence: 50,
      })),
    }));
    await generateHypotheses(sess, input);
    const call = callAIMock.mock.calls[0];
    const opts = call[3] as { log?: { phase?: string; feature?: string; modelTier?: string } };
    expect(opts.log?.phase).toBe("hypothesis");
    expect(opts.log?.feature).toBe("remediation");
    expect(opts.log?.modelTier).toBe("mini");
  });

  it("includes the diagnosis and alert body in the user message", async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      hypotheses: Array.from({ length: 3 }, (_, i) => ({
        id: `h${i}`, diagnosis: "d", reasoning: "r", confidence: 50,
      })),
    }));
    await generateHypotheses(sess, input);
    const call = callAIMock.mock.calls[0];
    const msgs = call[2] as { role: string; content: string }[];
    expect(msgs[0].content).toContain(input.diagnosis);
    expect(msgs[0].content).toContain(input.alertTitle);
  });

  it("includes repoSnapshot when provided", async () => {
    callAIMock.mockResolvedValueOnce(JSON.stringify({
      hypotheses: Array.from({ length: 3 }, (_, i) => ({
        id: `h${i}`, diagnosis: "d", reasoning: "r", confidence: 50,
      })),
    }));
    await generateHypotheses(sess, { ...input, repoSnapshot: "files: src/a.ts, src/b.ts" });
    const call = callAIMock.mock.calls[0];
    const msgs = call[2] as { role: string; content: string }[];
    expect(msgs[0].content).toContain("Repo context");
    expect(msgs[0].content).toContain("files: src/a.ts");
  });
});

// ── Constants sanity ───────────────────────────────────────────────────────

describe("constants", () => {
  it("MIN and MAX are sensible", () => {
    expect(MIN_HYPOTHESES).toBeGreaterThanOrEqual(1);
    expect(MAX_HYPOTHESES).toBeGreaterThanOrEqual(MIN_HYPOTHESES);
    expect(MAX_HYPOTHESES).toBeLessThanOrEqual(10);
  });
});
