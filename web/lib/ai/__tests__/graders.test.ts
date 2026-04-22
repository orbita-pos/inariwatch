/**
 * Tests for web/lib/ai/graders.ts — OpenAI Graders API adapter (Fase 1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  runGoldenDataset,
  buildModelSample,
  GradersDisabledError,
  type GoldenDatasetRecord,
} from "../graders";

function sampleRecord(bugId: string, fixPattern: string): GoldenDatasetRecord {
  return {
    input: {
      alert_title: "TypeError: Cannot read property x of undefined",
      alert_body: "stack trace...",
      alert_source: ["sentry"],
      alert_repo: "orbita-pos/demo",
      alert_fingerprint: "abc123",
    },
    expected: {
      fix_pattern: fixPattern,
      pattern_matched: true,
      bug_id: bugId,
    },
    output: {
      diagnosis_excerpt: "Root cause: null deref in handler",
      fix_summary: "Added null guard before property access",
      fix_files: [
        { path: "src/handler.ts", content_preview: "if (x) { return x.y; }" },
      ],
      self_review_score: 80,
      confidence: 0.9,
      outcome: "completed",
      pr_url: null,
      merge_strategy: "auto_merged",
    },
    metadata: {
      session_id: `session-${bugId}`,
      project: "demo",
      attempts: "1",
      error: null,
      step_count: 6,
      duration_s: 42,
    },
  };
}

function writeTempDataset(records: GoldenDatasetRecord[]): string {
  const file = join(tmpdir(), `graders-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
  return file;
}

describe("graders.ts", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.GRADERS_ENABLED;

  beforeEach(() => {
    // Explicit default — tests should never rely on leaking env state.
    delete process.env.GRADERS_ENABLED;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) {
      delete process.env.GRADERS_ENABLED;
    } else {
      process.env.GRADERS_ENABLED = originalEnv;
    }
  });

  describe("kill switch", () => {
    it("throws GradersDisabledError when GRADERS_ENABLED is unset and no apiKey override is given", async () => {
      const dataset = writeTempDataset([sampleRecord("bug-1", "null guard")]);
      try {
        await expect(
          runGoldenDataset({ modelLabel: "test-model", dataset })
        ).rejects.toBeInstanceOf(GradersDisabledError);
      } finally {
        unlinkSync(dataset);
      }
    });

    it("bypasses the kill switch when apiKey is passed directly (test/integration use)", async () => {
      const dataset = writeTempDataset([sampleRecord("bug-1", "null guard")]);
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ reward: 1.0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch;

      try {
        const report = await runGoldenDataset({
          modelLabel: "test-model",
          dataset,
          apiKey: "sk-test",
          endpoint: "https://api.openai.example/graders",
        });
        expect(report.recordCount).toBe(1);
      } finally {
        unlinkSync(dataset);
      }
    });
  });

  describe("runGoldenDataset", () => {
    it("aggregates pass-rate and average score across dataset rows", async () => {
      const dataset = writeTempDataset([
        sampleRecord("bug-1", "null guard"),
        sampleRecord("bug-2", "typo fix"),
        sampleRecord("bug-3", "timeout"),
      ]);

      // First two rows pass (reward=1), third fails (reward=0).
      let callCount = 0;
      global.fetch = vi.fn(async () => {
        const reward = callCount++ < 2 ? 1.0 : 0.0;
        return new Response(JSON.stringify({ reward }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        const report = await runGoldenDataset({
          modelLabel: "m",
          dataset,
          apiKey: "sk-test",
          endpoint: "https://api.openai.example/graders",
          concurrency: 1, // deterministic order for the pass-count assertion above
        });

        expect(report.recordCount).toBe(3);
        expect(report.rows).toHaveLength(3);
        expect(report.passRate).toBeCloseTo(2 / 3);
        expect(report.averageScore).toBeCloseTo(2 / 3);
        expect(report.rows[0].passed).toBe(true);
        expect(report.rows[2].passed).toBe(false);
        expect(report.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        unlinkSync(dataset);
      }
    });

    it("records the error string when a graders call fails, without aborting the run", async () => {
      const dataset = writeTempDataset([
        sampleRecord("bug-1", "null guard"),
        sampleRecord("bug-2", "typo fix"),
      ]);

      let callCount = 0;
      global.fetch = vi.fn(async () => {
        if (callCount++ === 0) {
          return new Response("rate limited", {
            status: 429,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response(JSON.stringify({ reward: 1.0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      try {
        const report = await runGoldenDataset({
          modelLabel: "m",
          dataset,
          apiKey: "sk-test",
          endpoint: "https://api.openai.example/graders",
          concurrency: 1,
        });

        expect(report.recordCount).toBe(2);
        expect(report.rows[0].error).toMatch(/Graders API error \(429\)/);
        expect(report.rows[0].passed).toBe(false);
        expect(report.rows[1].error).toBeNull();
        expect(report.rows[1].passed).toBe(true);
      } finally {
        unlinkSync(dataset);
      }
    });

    it("surfaces a parse error when the dataset file is malformed", async () => {
      const file = join(tmpdir(), `graders-bad-${Date.now()}.jsonl`);
      writeFileSync(file, "{ not valid json }\n");

      try {
        await expect(
          runGoldenDataset({
            modelLabel: "m",
            dataset: file,
            apiKey: "sk-test",
          })
        ).rejects.toThrow(/Failed to parse/);
      } finally {
        unlinkSync(file);
      }
    });

    it("rejects a response missing the reward field", async () => {
      const dataset = writeTempDataset([sampleRecord("bug-1", "x")]);
      global.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ not_reward: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch;

      try {
        const report = await runGoldenDataset({
          modelLabel: "m",
          dataset,
          apiKey: "sk-test",
          endpoint: "https://api.openai.example/graders",
        });

        expect(report.rows[0].error).toMatch(/missing 'reward'/);
      } finally {
        unlinkSync(dataset);
      }
    });
  });

  describe("buildModelSample", () => {
    it("concatenates diagnosis, fix summary, and file previews", () => {
      const rec = sampleRecord("bug-x", "fix");
      const sample = buildModelSample(rec);

      expect(sample).toContain("Root cause");
      expect(sample).toContain("null guard");
      expect(sample).toContain("src/handler.ts");
      expect(sample).toContain("if (x)");
    });

    it("omits null diagnosis / fix summary gracefully", () => {
      const rec = sampleRecord("bug-x", "fix");
      rec.output.diagnosis_excerpt = null;
      rec.output.fix_summary = null;
      const sample = buildModelSample(rec);

      expect(sample).toContain("src/handler.ts");
      expect(sample).not.toMatch(/null/);
    });
  });
});
