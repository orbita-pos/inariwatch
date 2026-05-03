/**
 * v0.3 S4 — eval harness sanity tests for slack / telegram / push.
 *
 * Same coverage strategy as `eval.test.ts`:
 *   - hand-craft outputs that hit / miss specific rubric clauses
 *   - assert the rubric scorer reports the expected delta + failure
 *     message
 *   - smoke-test `runEval` against a stub dispatch + mock judge
 *
 * No real models are spawned. Real-substrate runs go through the CLI
 * (`packages/ai-router/src/eval/run.ts`) + production wrapper
 * (`web/scripts/run-eval.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  NOTIFY_COMPOSE_SLACK_CORPUS,
  type ComposeSlackEvalItem,
} from "../eval/corpus-slack";
import {
  NOTIFY_COMPOSE_TELEGRAM_CORPUS,
  type ComposeTelegramEvalItem,
} from "../eval/corpus-telegram";
import {
  NOTIFY_COMPOSE_PUSH_CORPUS,
  type ComposePushEvalItem,
} from "../eval/corpus-push";
import {
  countUnescapedReserved,
  extractSlackSectionText,
  findFenceMarkers,
  findHereMention,
  MARKDOWNV2_RESERVED,
  scoreRubricPush,
  scoreRubricSlack,
  scoreRubricTelegram,
  type ComposePushEvalOutput,
  type ComposeSlackEvalOutput,
  type ComposeTelegramEvalOutput,
} from "../eval/judge-channels";
import { runEval } from "../eval/run";
import { TASKS } from "../tasks";
import type { ItemScore, JudgeFn } from "../eval/judge";
import { scoreItemWith } from "../eval/judge";

// ── Slack ──────────────────────────────────────────────────────────────────

const SLACK_FE: ComposeSlackEvalItem = NOTIFY_COMPOSE_SLACK_CORPUS.find(
  (i) => i.id === "fe-typeerror-undef",
) as ComposeSlackEvalItem;

describe("slack rubric", () => {
  it("perfect output earns 60/60", () => {
    const output: ComposeSlackEvalOutput = {
      text: "TypeError on form.tsx",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "TypeError reading 'id' off undefined inside *form.tsx*. The handleSubmit path is failing.",
          },
        },
      ],
    };
    const { score, failures } = scoreRubricSlack(SLACK_FE.rubric, output);
    expect(score).toBe(60);
    expect(failures).toEqual([]);
  });

  it("flags <!here> when forbidHereMention is on", () => {
    const output: ComposeSlackEvalOutput = {
      text: "TypeError",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "<!here> form.tsx is broken. TypeError.",
          },
        },
      ],
    };
    const { score, failures } = scoreRubricSlack(SLACK_FE.rubric, output);
    // -30 for the channel mention.
    expect(score).toBeLessThanOrEqual(30);
    expect(failures.some((f) => f.includes("<!here>"))).toBe(true);
  });

  it("deducts for missing must-contain phrase", () => {
    const output: ComposeSlackEvalOutput = {
      text: "alert",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Generic prose without the file reference.",
          },
        },
      ],
    };
    const { score, failures } = scoreRubricSlack(SLACK_FE.rubric, output);
    // -5 for missing 'form.tsx'. Plus block count is in window, length OK.
    // But subjectKeywords are missing too → -10 → final 45.
    expect(score).toBe(45);
    expect(failures.some((f) => f.includes("form.tsx"))).toBe(true);
  });

  it("deducts for markdown fences inside section text", () => {
    const output: ComposeSlackEvalOutput = {
      text: "x",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "TypeError\n```\nstack\n```\n form.tsx",
          },
        },
      ],
    };
    const { score, failures } = scoreRubricSlack(SLACK_FE.rubric, output);
    expect(failures.some((f) => f.includes("fences"))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it("flags zero-block payload", () => {
    const output: ComposeSlackEvalOutput = {
      text: "TypeError on form.tsx",
      blocks: [],
    };
    const { score, failures } = scoreRubricSlack(SLACK_FE.rubric, output);
    expect(failures.some((f) => f.includes("block count"))).toBe(true);
    expect(score).toBeLessThan(60);
  });
});

describe("slack helpers", () => {
  it("extractSlackSectionText concats nested section text", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "A" } },
      { type: "section", text: { type: "mrkdwn", text: "B" } },
    ];
    expect(extractSlackSectionText(blocks)).toBe("A\n\nB");
  });

  it("findFenceMarkers finds triple backticks", () => {
    expect(findFenceMarkers("hello ```code```")).toBe(true);
    expect(findFenceMarkers("plain text")).toBe(false);
  });

  it("findHereMention is case-insensitive", () => {
    expect(findHereMention("<!here> alert")).toBe(true);
    expect(findHereMention("<!CHANNEL> alert")).toBe(true);
    expect(findHereMention("normal text")).toBe(false);
  });
});

// ── Telegram ───────────────────────────────────────────────────────────────

const TG_FE: ComposeTelegramEvalItem = NOTIFY_COMPOSE_TELEGRAM_CORPUS.find(
  (i) => i.id === "fe-typeerror-undef",
) as ComposeTelegramEvalItem;

describe("telegram rubric", () => {
  it("perfect output earns 60/60", () => {
    // Body is fully escaped — every reserved char is preceded by a `\`.
    // Length is in window; parse_mode pinned.
    const output: ComposeTelegramEvalOutput = {
      text: "TypeError reading 'id' off undefined inside form\\.tsx\\. handleSubmit failing\\.",
      parse_mode: "MarkdownV2",
      inline_keyboard: null,
    };
    const { score, failures } = scoreRubricTelegram(TG_FE.rubric, output);
    expect(score).toBe(60);
    expect(failures).toEqual([]);
  });

  it("deducts for unescaped reserved chars", () => {
    const output: ComposeTelegramEvalOutput = {
      text: "TypeError in form.tsx — something happened (not great)!",
      parse_mode: "MarkdownV2",
      inline_keyboard: null,
    };
    const { score, failures } = scoreRubricTelegram(TG_FE.rubric, output);
    // Many unescaped reserved chars. Score should drop by at least 10.
    expect(score).toBeLessThan(60);
    expect(failures.some((f) => f.includes("unescaped"))).toBe(true);
  });

  it("flags non-MarkdownV2 parse_mode", () => {
    const output: ComposeTelegramEvalOutput = {
      text: "TypeError reading 'id' off undefined inside form\\.tsx",
      parse_mode: "HTML",
      inline_keyboard: null,
    };
    const { score, failures } = scoreRubricTelegram(TG_FE.rubric, output);
    expect(failures.some((f) => f.includes("HTML"))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it("expects inline_keyboard when rubric demands it", () => {
    const item = NOTIFY_COMPOSE_TELEGRAM_CORPUS.find(
      (i) => i.id === "be-prisma-conn-pool",
    ) as ComposeTelegramEvalItem;
    const output: ComposeTelegramEvalOutput = {
      text: "Prisma pool exhausted\\. Investigate\\.",
      parse_mode: "MarkdownV2",
      inline_keyboard: null,
    };
    const { score, failures } = scoreRubricTelegram(item.rubric, output);
    expect(failures.some((f) => f.includes("inline_keyboard"))).toBe(true);
    expect(score).toBeLessThan(60);
  });
});

describe("telegram helpers", () => {
  it("countUnescapedReserved flags raw `.`", () => {
    expect(countUnescapedReserved("hello.")).toBe(1);
    expect(countUnescapedReserved("hello\\.")).toBe(0);
  });

  it("MARKDOWNV2_RESERVED covers the full spec list", () => {
    for (const c of "_*[]()~`>#+-=|{}.!") {
      expect(MARKDOWNV2_RESERVED.has(c)).toBe(true);
    }
    // Sanity: chars not in the set are not flagged.
    expect(MARKDOWNV2_RESERVED.has("a")).toBe(false);
    expect(MARKDOWNV2_RESERVED.has(" ")).toBe(false);
  });
});

// ── Push ───────────────────────────────────────────────────────────────────

const PUSH_FE: ComposePushEvalItem = NOTIFY_COMPOSE_PUSH_CORPUS.find(
  (i) => i.id === "fe-typeerror-undef",
) as ComposePushEvalItem;

describe("push rubric", () => {
  it("perfect output earns 60/60", () => {
    const output: ComposePushEvalOutput = {
      title: "TypeError on form.tsx",
      body: "Form submit broke — TypeError reading 'id' off undefined.",
      actions: [{ id: "ack", title: "Acknowledge" }],
      category: "alert.critical",
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(score).toBe(60);
    expect(failures).toEqual([]);
  });

  it("deducts for over-cap title", () => {
    const output: ComposePushEvalOutput = {
      title: "T".repeat(60),
      body: "form is broken",
      actions: [],
      category: null,
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures.some((f) => f.includes("title too long"))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it("deducts for over-cap body", () => {
    const output: ComposePushEvalOutput = {
      title: "TypeError",
      body: "x".repeat(250),
      actions: [],
      category: null,
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures.some((f) => f.includes("body too long"))).toBe(true);
  });

  it("flags too many actions", () => {
    const output: ComposePushEvalOutput = {
      title: "X",
      body: "form is broken",
      actions: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
        { id: "d", title: "D" },
        { id: "e", title: "E" },
      ],
      category: null,
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures.some((f) => f.includes("actions count"))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it("flags invalid action id", () => {
    const output: ComposePushEvalOutput = {
      title: "X",
      body: "form is broken",
      actions: [{ id: "BadId", title: "Acknowledge" }],
      category: null,
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures.some((f) => f.includes("invalid action id"))).toBe(true);
  });

  it("flags out-of-allowlist category", () => {
    const output: ComposePushEvalOutput = {
      title: "TypeError",
      body: "form is broken",
      actions: [{ id: "ack", title: "Ack" }],
      category: "deploy.failed", // FE alert allow-list only contains alert.critical
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures.some((f) => f.includes("not in allow list"))).toBe(true);
    expect(score).toBeLessThan(60);
  });

  it("null category is always allowed", () => {
    const output: ComposePushEvalOutput = {
      title: "TypeError",
      body: "form is broken",
      actions: [{ id: "ack", title: "Ack" }],
      category: null,
    };
    const { score, failures } = scoreRubricPush(PUSH_FE.rubric, output);
    expect(failures).not.toContain("category");
    expect(score).toBe(60);
  });
});

// ── Corpus invariants ─────────────────────────────────────────────────────

describe("corpus invariants (S4)", () => {
  it.each([
    ["slack", NOTIFY_COMPOSE_SLACK_CORPUS],
    ["telegram", NOTIFY_COMPOSE_TELEGRAM_CORPUS],
    ["push", NOTIFY_COMPOSE_PUSH_CORPUS],
  ] as const)("%s corpus has 30+ items", (_label, corpus) => {
    expect(corpus.length).toBeGreaterThanOrEqual(30);
  });

  it.each([
    ["slack", NOTIFY_COMPOSE_SLACK_CORPUS],
    ["telegram", NOTIFY_COMPOSE_TELEGRAM_CORPUS],
    ["push", NOTIFY_COMPOSE_PUSH_CORPUS],
  ] as const)("%s corpus has unique ids", (_label, corpus) => {
    const ids = corpus.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── End-to-end runner smoke (mock judge + stub dispatch) ──────────────────

describe("runEval (S4 channel runners)", () => {
  it("slack — drives 3 mock items end-to-end", async () => {
    const tiny = NOTIFY_COMPOSE_SLACK_CORPUS.slice(0, 3);
    const judge: JudgeFn<ComposeSlackEvalItem, ComposeSlackEvalOutput> =
      async () => ({ score: 30, reasoning: "ok" });
    const report = await runEval<ComposeSlackEvalItem, ComposeSlackEvalOutput>({
      corpus: tiny,
      substrate: "cloud",
      task: TASKS.NOTIFY_COMPOSE_SLACK,
      judge,
      dispatchFn: async (item) => ({
        output: stubSlackOutputFor(item),
        modelUsed: "stub-model",
      }),
      scorer: async (
        item: ComposeSlackEvalItem,
        output: ComposeSlackEvalOutput,
        j: JudgeFn<ComposeSlackEvalItem, ComposeSlackEvalOutput>,
      ): Promise<ItemScore> => {
        const r = scoreRubricSlack(item.rubric, output);
        return scoreItemWith(item, output, r, j);
      },
    });
    expect(report.n_examples).toBe(3);
    expect(report.task).toBe(TASKS.NOTIFY_COMPOSE_SLACK);
    expect(report.mean_score).toBeGreaterThan(0);
  });

  it("telegram — drives 3 mock items end-to-end", async () => {
    const tiny = NOTIFY_COMPOSE_TELEGRAM_CORPUS.slice(0, 3);
    const judge: JudgeFn<
      ComposeTelegramEvalItem,
      ComposeTelegramEvalOutput
    > = async () => ({ score: 25, reasoning: "ok" });
    const report = await runEval<
      ComposeTelegramEvalItem,
      ComposeTelegramEvalOutput
    >({
      corpus: tiny,
      substrate: "cloud",
      task: TASKS.NOTIFY_COMPOSE_TELEGRAM,
      judge,
      dispatchFn: async (item) => ({
        output: stubTelegramOutputFor(item),
        modelUsed: "stub-model",
      }),
      scorer: async (item, output, j) => {
        const r = scoreRubricTelegram(item.rubric, output);
        return scoreItemWith(item, output, r, j);
      },
    });
    expect(report.n_examples).toBe(3);
    expect(report.task).toBe(TASKS.NOTIFY_COMPOSE_TELEGRAM);
  });

  it("push — drives 3 mock items end-to-end", async () => {
    const tiny = NOTIFY_COMPOSE_PUSH_CORPUS.slice(0, 3);
    const judge: JudgeFn<ComposePushEvalItem, ComposePushEvalOutput> =
      async () => ({ score: 28, reasoning: "ok" });
    const report = await runEval<ComposePushEvalItem, ComposePushEvalOutput>({
      corpus: tiny,
      substrate: "cloud",
      task: TASKS.NOTIFY_COMPOSE_PUSH,
      judge,
      dispatchFn: async (item) => ({
        output: stubPushOutputFor(item),
        modelUsed: "stub-model",
      }),
      scorer: async (item, output, j) => {
        const r = scoreRubricPush(item.rubric, output);
        return scoreItemWith(item, output, r, j);
      },
    });
    expect(report.n_examples).toBe(3);
    expect(report.task).toBe(TASKS.NOTIFY_COMPOSE_PUSH);
  });
});

// Stubs that satisfy each item's rubric so the runner doesn't degenerate
// to an all-zeros report when measuring its own plumbing.

function stubSlackOutputFor(
  item: ComposeSlackEvalItem,
): ComposeSlackEvalOutput {
  const must = (item.rubric.textMustContain ?? [])
    .concat(item.rubric.textKeywords ?? [])
    .join(" ");
  return {
    text: item.input.alert.title.slice(0, 140),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${item.input.alert.title}. ${must}. Investigate the incident link.`,
        },
      },
    ],
  };
}

function stubTelegramOutputFor(
  item: ComposeTelegramEvalItem,
): ComposeTelegramEvalOutput {
  const must = (item.rubric.textMustContain ?? [])
    .concat(item.rubric.textKeywords ?? [])
    .join(" ");
  // Escape every reserved char in the body so the unescaped-counter
  // doesn't dock the rubric score in the smoke test.
  const escape = (s: string): string => {
    let out = "";
    for (const c of s) {
      if (MARKDOWNV2_RESERVED.has(c)) out += "\\";
      out += c;
    }
    return out;
  };
  const inline = item.rubric.expectInlineKeyboard
    ? [[{ text: "Ack", callback_data: "ack" }]]
    : null;
  return {
    text: escape(`${item.input.alert.title}. ${must}. Investigate.`),
    parse_mode: "MarkdownV2",
    inline_keyboard: inline,
  };
}

function stubPushOutputFor(item: ComposePushEvalItem): ComposePushEvalOutput {
  const titleKw = item.rubric.titleKeywords?.[0] ?? "Alert";
  const must = item.rubric.bodyMustContain?.[0] ?? "";
  const cat = item.rubric.expectedCategoryAllowList?.[0] ?? null;
  return {
    title: `${titleKw} alert`.slice(0, 50),
    body: `${item.input.alert.title}. ${must}`.slice(0, 200),
    actions: item.input.suggest_actions
      ? [{ id: "ack", title: "Acknowledge" }]
      : [],
    category: cat,
  };
}
