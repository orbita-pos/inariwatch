/**
 * v0.3 S3 — eval harness sanity tests.
 *
 * These don't call any real model. We pass canned outputs into the rubric
 * + judge and assert that the scoring math + report aggregation works.
 * Real model evaluation is an opt-in CLI run (see `eval/run.ts` + the
 * production wrapper in `web/scripts/run-eval.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  NOTIFY_COMPOSE_EMAIL_CORPUS,
  type ComposeEmailEvalItem,
} from "../eval/corpus";
import {
  PROMOTION_THRESHOLD,
  buildJudgePrompt,
  buildReport,
  scoreItem,
  scoreRubric,
  type ComposeEmailEvalOutput,
  type JudgeFn,
} from "../eval/judge";
import { runEval } from "../eval/run";
import { TASKS } from "../tasks";

const SAMPLE_ITEM: ComposeEmailEvalItem = NOTIFY_COMPOSE_EMAIL_CORPUS.find(
  (i) => i.id === "fe-typeerror-undef",
) as ComposeEmailEvalItem;

describe("eval rubric", () => {
  it("perfect output earns 60/60 + judge stays at 0 deductions", () => {
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError on form.tsx — undefined id",
      body:
        "Production hit a TypeError reading 'id' off undefined inside form.tsx. The handleSubmit path is failing for ~2% of submissions.",
      suggested_actions: ["Roll back deploy", "Check form payload"],
    };
    const { score, failures } = scoreRubric(SAMPLE_ITEM.rubric, output);
    expect(score).toBe(60);
    expect(failures).toEqual([]);
  });

  it("missing must-contain phrases deduct 5 each, capped at 30", () => {
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError — undefined id",
      body: "Some generic prose without the required tokens.",
      suggested_actions: ["Investigate"],
    };
    const { score, failures } = scoreRubric(SAMPLE_ITEM.rubric, output);
    // Rubric requires `form.tsx` AND `TypeError` in body. Both missing → -10.
    // Length 50 chars > 30 minLen so no length penalty.
    expect(score).toBe(50);
    expect(failures.some((f) => f.includes("form.tsx"))).toBe(true);
    expect(failures.some((f) => f.includes("TypeError"))).toBe(true);
  });

  it("body too long deducts 10 once", () => {
    const longBody = "TypeError in form.tsx. ".repeat(80); // ~1840 chars
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError",
      body: longBody,
      suggested_actions: ["Roll back"],
    };
    const { score, failures } = scoreRubric(SAMPLE_ITEM.rubric, output);
    expect(failures.some((f) => f.includes("body too long"))).toBe(true);
    expect(score).toBe(50);
  });

  it("manager-targeted alert leaks stack traces → fail badly", () => {
    const item = NOTIFY_COMPOSE_EMAIL_CORPUS.find(
      (i) => i.id === "mgr-revenue-impact",
    ) as ComposeEmailEvalItem;
    const output: ComposeEmailEvalOutput = {
      subject: "Checkout broken",
      body:
        "Stack: TypeError at PrismaClient.tsx:42. Checkout error rate is 8%.",
      suggested_actions: ["Investigate"],
    };
    const { score, failures } = scoreRubric(item.rubric, output);
    // bodyMustNotContain has "stack", "PrismaClient", "TypeError" → 3 leaks
    // → -30 (capped). subject "checkout" is in keywords → +0. Length OK.
    expect(score).toBe(30);
    expect(failures.some((f) => f.includes("PrismaClient"))).toBe(true);
  });

  it("suggested-actions count outside [1,4] deducts 10", () => {
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError on form.tsx",
      body: "TypeError at form.tsx — investigate the handleSubmit path.",
      suggested_actions: [],
    };
    const { score } = scoreRubric(SAMPLE_ITEM.rubric, output);
    expect(score).toBe(50); // -10 for empty actions list
  });
});

describe("eval judge prompt", () => {
  it("includes alert + composition fields the judge can score", () => {
    const output: ComposeEmailEvalOutput = {
      subject: "S",
      body: "B",
      suggested_actions: ["a"],
    };
    const { system, user } = buildJudgePrompt(SAMPLE_ITEM, output);
    expect(system).toContain("Tone match");
    expect(system).toContain("Factual accuracy");
    expect(user).toContain(SAMPLE_ITEM.input.alert.title);
    expect(user).toContain('"language":"en"');
  });
});

describe("scoreItem combines rubric + judge", () => {
  it("rubric-pass + judge-40 yields 100", async () => {
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError on form.tsx — undefined id",
      body:
        "TypeError reading 'id' off undefined. Triggered by form.tsx submission.",
      suggested_actions: ["Roll back", "Check payload"],
    };
    const fakeJudge: JudgeFn = async () => ({ score: 40, reasoning: "perfect" });
    const r = await scoreItem(SAMPLE_ITEM, output, fakeJudge);
    expect(r.score).toBe(100);
    expect(r.rubricScore).toBe(60);
    expect(r.judgeScore).toBe(40);
  });

  it("clamps judge score to [0, 40]", async () => {
    const output: ComposeEmailEvalOutput = {
      subject: "TypeError on form.tsx",
      body: "TypeError in form.tsx — investigate handleSubmit.",
      suggested_actions: ["Roll back"],
    };
    const overEager: JudgeFn = async () => ({ score: 999, reasoning: "" });
    const r = await scoreItem(SAMPLE_ITEM, output, overEager);
    expect(r.judgeScore).toBe(40);
  });
});

describe("runEval aggregates a report", () => {
  it("smoke run with 3 mock examples computes mean correctly", async () => {
    const tinyCorpus = NOTIFY_COMPOSE_EMAIL_CORPUS.slice(0, 3);
    const fakeJudge: JudgeFn = async () => ({ score: 30, reasoning: "ok" });
    const report = await runEval({
      corpus: tinyCorpus,
      substrate: "cloud",
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      judge: fakeJudge,
      dispatchFn: async (item) => ({
        // Hand-crafted output that satisfies each item's rubric.
        output: stubOutputFor(item),
        modelUsed: "stub-model",
      }),
    });
    expect(report.n_examples).toBe(3);
    expect(report.task).toBe(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(report.substrate).toBe("cloud");
    expect(report.model).toBe("stub-model");
    expect(report.mean_score).toBeGreaterThanOrEqual(60);
  });

  it("dispatch failures count as 0 and don't crash the run", async () => {
    const tinyCorpus = NOTIFY_COMPOSE_EMAIL_CORPUS.slice(0, 2);
    const fakeJudge: JudgeFn = async () => ({ score: 20, reasoning: "" });
    let calls = 0;
    const report = await runEval({
      corpus: tinyCorpus,
      substrate: "user-sidecar",
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      judge: fakeJudge,
      dispatchFn: async (item) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("simulated sidecar offline");
        }
        return { output: stubOutputFor(item), modelUsed: "qwen2.5-coder-1.5b" };
      },
    });
    expect(report.n_examples).toBe(2);
    expect(report.examples[0].score).toBe(0);
    expect(report.examples[0].rubricFailures[0]).toContain("dispatch failed");
    expect(report.examples[1].score).toBeGreaterThan(0);
  });

  it("buildReport flags `passed: true` only at >= 85", () => {
    const high = buildReport({
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      substrate: "cloud",
      model: "gpt-4o-mini",
      examples: [
        { id: "x", score: 90, rubricScore: 50, judgeScore: 40, rubricFailures: [] },
      ],
    });
    expect(high.passed).toBe(true);
    expect(PROMOTION_THRESHOLD).toBe(85);

    const low = buildReport({
      task: TASKS.NOTIFY_COMPOSE_EMAIL,
      substrate: "cloud",
      model: "gpt-4o-mini",
      examples: [
        { id: "x", score: 84.9, rubricScore: 50, judgeScore: 35, rubricFailures: [] },
      ],
    });
    expect(low.passed).toBe(false);
  });
});

// Build a stub output that hits each item's rubric. Used by smoke tests
// so the runner returns reasonable scores without a model in the loop.
function stubOutputFor(item: ComposeEmailEvalItem): ComposeEmailEvalOutput {
  const r = item.rubric;
  const subjectKw = r.subjectKeywords?.[0] ?? "Alert";
  const subject = `${subjectKw} — ${item.input.alert.title.slice(0, 40)}`;
  // Concatenate every must-contain phrase so the rubric sees them.
  const phrases = (r.bodyMustContain ?? []).join(", ");
  const body = `${item.input.alert.title}. ${phrases}. Action required: investigate the alert link and triage with the on-call.`;
  return {
    subject,
    body,
    suggested_actions: ["Roll back deploy", "Page on-call"],
  };
}

// Sanity guard: corpus is at least the documented size. If a future
// session prunes below this, the contract regresses.
describe("corpus size", () => {
  it("ships at least 30 items", () => {
    expect(NOTIFY_COMPOSE_EMAIL_CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it("every item has a unique id", () => {
    const ids = NOTIFY_COMPOSE_EMAIL_CORPUS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
