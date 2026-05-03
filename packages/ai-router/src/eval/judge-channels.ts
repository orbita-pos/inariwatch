// v0.3 S4 — channel-specific rubric scorers + LLM-as-judge prompts.
//
// Mirrors `judge.ts` (the email scorer). Each channel has its own
// hard-rubric scorer (60 points) that knows the channel's format
// constraints, and shares the LLM-as-judge interface (40 points) — the
// judge gets a per-channel system prompt that highlights what to look
// for (Slack mrkdwn vs Telegram MarkdownV2 vs push truncation).
//
// Final score per item is rubric (0-60) + judge (0-40), capped at 100,
// with the same promotion threshold (85) as the email evaluator.

import type {
  ComposeSlackEvalItem,
  ComposeSlackEvalRubric,
} from "./corpus-slack";
import type {
  ComposeTelegramEvalItem,
  ComposeTelegramEvalRubric,
  ComposeTelegramEvalInput,
} from "./corpus-telegram";
import type {
  ComposePushEvalItem,
  ComposePushEvalRubric,
} from "./corpus-push";

// ── Output shapes the runner produces from a dispatch ─────────────────────

export interface ComposeSlackEvalOutput {
  text: string;
  blocks: unknown[];
}

export interface ComposeTelegramEvalOutput {
  text: string;
  parse_mode: string;
  inline_keyboard?: Array<Array<unknown>> | null;
}

export interface ComposePushEvalOutput {
  title: string;
  body: string;
  actions: Array<{ id: string; title: string }>;
  category?: string | null;
}

// ── Slack hard rubric ─────────────────────────────────────────────────────

/**
 * Returns the concatenation of all `text` fields inside Slack `section`
 * blocks. Used by the rubric to keyword-search the model's prose
 * regardless of how many sections it nested into.
 */
export function extractSlackSectionText(blocks: unknown[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    const text = blk.text;
    if (text && typeof text === "object") {
      const t = (text as Record<string, unknown>).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out.join("\n\n");
}

/**
 * Detect markdown fences (```...```) inside any block text. The cloud
 * Slack bot doesn't render fences as code blocks (Slack mrkdwn uses
 * triple-backticks for that, but the parser also tolerates leading
 * backticks); to keep eval scoring strict against the prompt that
 * forbids fences, any leading triple-backtick is a -10.
 */
export function findFenceMarkers(text: string): boolean {
  return /```/.test(text);
}

/** Match `<!here>` / `<!channel>` (case-insensitive). */
export function findHereMention(text: string): boolean {
  return /<!\s*(here|channel)\s*>/i.test(text);
}

export function scoreRubricSlack(
  rubric: ComposeSlackEvalRubric,
  output: ComposeSlackEvalOutput,
): { score: number; failures: string[] } {
  const failures: string[] = [];
  let score = 60;

  const sectionText = extractSlackSectionText(output.blocks);

  // Block count window — default [1, 4]. Out-of-range = -10.
  const [minB, maxB] = rubric.expectedBlocksRange ?? [1, 4];
  if (output.blocks.length < minB || output.blocks.length > maxB) {
    failures.push(
      `block count ${output.blocks.length} outside [${minB}, ${maxB}]`,
    );
    score -= 10;
  }

  // textKeywords — at least ONE in the section text.
  if (rubric.textKeywords && rubric.textKeywords.length > 0) {
    const lc = sectionText.toLowerCase();
    const found = rubric.textKeywords.some((kw) =>
      lc.includes(kw.toLowerCase()),
    );
    if (!found) {
      failures.push(
        `text missing all keywords [${rubric.textKeywords.join(", ")}]`,
      );
      score -= 10;
    }
  }

  // textMustContain — every entry counted; missing = -5 each, max -30.
  if (rubric.textMustContain && rubric.textMustContain.length > 0) {
    const lc = sectionText.toLowerCase();
    let missing = 0;
    for (const phrase of rubric.textMustContain) {
      if (!lc.includes(phrase.toLowerCase())) {
        missing += 1;
        failures.push(`text missing '${phrase}'`);
      }
    }
    score -= Math.min(30, missing * 5);
  }

  // textMustNotContain — each occurrence -10, max -30.
  if (rubric.textMustNotContain && rubric.textMustNotContain.length > 0) {
    const lc = sectionText.toLowerCase();
    let leaks = 0;
    for (const phrase of rubric.textMustNotContain) {
      if (lc.includes(phrase.toLowerCase())) {
        leaks += 1;
        failures.push(`text leaked '${phrase}'`);
      }
    }
    score -= Math.min(30, leaks * 10);
  }

  // Length window.
  const minLen = rubric.minTextChars ?? 20;
  const maxLen = rubric.maxTextChars ?? 1500;
  if (sectionText.length < minLen) {
    failures.push(`text too short (${sectionText.length} < ${minLen})`);
    score -= 10;
  } else if (sectionText.length > maxLen) {
    failures.push(`text too long (${sectionText.length} > ${maxLen})`);
    score -= 10;
  }

  // Markdown fence in any block — the prompt forbids this.
  for (const b of output.blocks) {
    if (!b || typeof b !== "object") continue;
    const t = (b as Record<string, unknown>).text;
    if (t && typeof t === "object") {
      const inner = (t as Record<string, unknown>).text;
      if (typeof inner === "string" && findFenceMarkers(inner)) {
        failures.push("block text contains markdown fences");
        score -= 10;
        break;
      }
    }
  }

  // Channel-mention guard.
  if (rubric.forbidHereMention) {
    if (
      findHereMention(output.text) ||
      findHereMention(sectionText)
    ) {
      failures.push("output contains <!here>/<!channel> mention");
      score -= 30;
    }
  }

  return { score: Math.max(0, score), failures };
}

// ── Telegram hard rubric ──────────────────────────────────────────────────

/** MarkdownV2 reserved chars per Telegram bot API. Mirror of the desktop
 * `MARKDOWNV2_RESERVED` const — keep in sync. */
export const MARKDOWNV2_RESERVED: ReadonlySet<string> = new Set(
  "_*[]()~`>#+-=|{}.!".split(""),
);

/**
 * Count unescaped reserved chars in `text`. A reserved char is OK when
 * preceded by `\`. The check skips reserved chars that are inside a
 * code span (between backticks) since the spec exempts those — to
 * stay simple we ignore the pair-matching and just skip backticks
 * themselves: we only flag reserved chars at byte i when bytes[i-1]
 * is not a backslash.
 */
export function countUnescapedReserved(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!MARKDOWNV2_RESERVED.has(c)) continue;
    if (i === 0) {
      n += 1;
      continue;
    }
    if (text[i - 1] !== "\\") {
      n += 1;
    }
  }
  return n;
}

export function scoreRubricTelegram(
  rubric: ComposeTelegramEvalRubric,
  output: ComposeTelegramEvalOutput,
): { score: number; failures: string[] } {
  const failures: string[] = [];
  let score = 60;

  // parse_mode pinned — non-MarkdownV2 = -10. The desktop parser
  // overrides this; the rubric still checks because cloud-side
  // composition could regress.
  if (output.parse_mode !== "MarkdownV2") {
    failures.push(`parse_mode '${output.parse_mode}' must be 'MarkdownV2'`);
    score -= 10;
  }

  // textKeywords.
  if (rubric.textKeywords && rubric.textKeywords.length > 0) {
    const lc = output.text.toLowerCase();
    const found = rubric.textKeywords.some((kw) =>
      lc.includes(kw.toLowerCase()),
    );
    if (!found) {
      failures.push(
        `text missing all keywords [${rubric.textKeywords.join(", ")}]`,
      );
      score -= 10;
    }
  }

  if (rubric.textMustContain && rubric.textMustContain.length > 0) {
    const lc = output.text.toLowerCase();
    let missing = 0;
    for (const phrase of rubric.textMustContain) {
      if (!lc.includes(phrase.toLowerCase())) {
        missing += 1;
        failures.push(`text missing '${phrase}'`);
      }
    }
    score -= Math.min(30, missing * 5);
  }

  if (rubric.textMustNotContain && rubric.textMustNotContain.length > 0) {
    const lc = output.text.toLowerCase();
    let leaks = 0;
    for (const phrase of rubric.textMustNotContain) {
      if (lc.includes(phrase.toLowerCase())) {
        leaks += 1;
        failures.push(`text leaked '${phrase}'`);
      }
    }
    score -= Math.min(30, leaks * 10);
  }

  const minLen = rubric.minTextChars ?? 20;
  const maxLen = rubric.maxTextChars ?? 1500;
  if (output.text.length < minLen) {
    failures.push(`text too short (${output.text.length} < ${minLen})`);
    score -= 10;
  } else if (output.text.length > maxLen) {
    failures.push(`text too long (${output.text.length} > ${maxLen})`);
    score -= 10;
  }

  // MarkdownV2 escape check — the bot 400s on unescaped reserved chars.
  if (rubric.enforceMarkdownV2Escape ?? true) {
    const unescaped = countUnescapedReserved(output.text);
    if (unescaped > 0) {
      failures.push(
        `${unescaped} unescaped MarkdownV2 reserved char${unescaped === 1 ? "" : "s"}`,
      );
      score -= Math.min(30, unescaped * 5);
    }
  }

  // Inline keyboard expectation.
  if (rubric.expectInlineKeyboard) {
    const kb = output.inline_keyboard;
    const present = Array.isArray(kb) && kb.length > 0 && kb.some((r) => r.length > 0);
    if (!present) {
      failures.push("expected inline_keyboard with at least one button");
      score -= 10;
    }
  }

  return { score: Math.max(0, score), failures };
}

// ── Push hard rubric ──────────────────────────────────────────────────────

export function scoreRubricPush(
  rubric: ComposePushEvalRubric,
  output: ComposePushEvalOutput,
): { score: number; failures: string[] } {
  const failures: string[] = [];
  let score = 60;

  const maxTitle = rubric.maxTitleChars ?? 50;
  const maxBody = rubric.maxBodyChars ?? 200;

  if (output.title.length > maxTitle) {
    failures.push(`title too long (${output.title.length} > ${maxTitle})`);
    score -= 10;
  }
  if (output.body.length > maxBody) {
    failures.push(`body too long (${output.body.length} > ${maxBody})`);
    score -= 10;
  }
  if (output.title.length === 0 && output.body.length === 0) {
    failures.push("title + body both empty");
    score -= 30;
  }

  if (rubric.titleKeywords && rubric.titleKeywords.length > 0) {
    const lc = output.title.toLowerCase();
    const found = rubric.titleKeywords.some((kw) =>
      lc.includes(kw.toLowerCase()),
    );
    if (!found) {
      failures.push(
        `title missing all keywords [${rubric.titleKeywords.join(", ")}]`,
      );
      score -= 10;
    }
  }

  if (rubric.bodyMustContain && rubric.bodyMustContain.length > 0) {
    const lc = output.body.toLowerCase();
    let missing = 0;
    for (const phrase of rubric.bodyMustContain) {
      if (!lc.includes(phrase.toLowerCase())) {
        missing += 1;
        failures.push(`body missing '${phrase}'`);
      }
    }
    score -= Math.min(30, missing * 5);
  }

  if (rubric.bodyMustNotContain && rubric.bodyMustNotContain.length > 0) {
    const lc = output.body.toLowerCase();
    let leaks = 0;
    for (const phrase of rubric.bodyMustNotContain) {
      if (lc.includes(phrase.toLowerCase())) {
        leaks += 1;
        failures.push(`body leaked '${phrase}'`);
      }
    }
    score -= Math.min(30, leaks * 10);
  }

  const [minA, maxA] = rubric.expectedActionsRange ?? [0, 3];
  if (output.actions.length < minA || output.actions.length > maxA) {
    failures.push(
      `actions count ${output.actions.length} outside [${minA}, ${maxA}]`,
    );
    score -= 10;
  }
  // Validate slug ids — the desktop parser already rejects invalid ids
  // but a model that produces them is making a tone error worth catching.
  for (const a of output.actions) {
    if (!/^[a-z0-9_-]+$/.test(a.id)) {
      failures.push(`invalid action id '${a.id}'`);
      score -= 5;
    }
  }

  // Category allow-list. Null is always allowed.
  if (rubric.expectedCategoryAllowList && output.category != null) {
    if (!rubric.expectedCategoryAllowList.includes(output.category)) {
      failures.push(
        `category '${output.category}' not in allow list [${rubric.expectedCategoryAllowList.join(", ")}]`,
      );
      score -= 10;
    }
  }

  return { score: Math.max(0, score), failures };
}

// ── Per-channel judge prompt builders ─────────────────────────────────────

export function buildSlackJudgePrompt(
  item: ComposeSlackEvalItem,
  output: ComposeSlackEvalOutput,
): { system: string; user: string } {
  const system =
    "You are evaluating a Slack alert message. Score on a 0-40 scale across FOUR axes (10 points each):\n" +
    "1. Tone — appropriate for the recipient role + Slack casual register\n" +
    "2. Factual accuracy — references real fields from the alert\n" +
    "3. Mrkdwn correctness — `*bold*` and `<url|label>` used appropriately, no leaked HTML/Markdown fences\n" +
    "4. Length — fits in a Slack notification (concise = 2 sentences, detailed = up to 3-4)\n\n" +
    "Respond with strict JSON, no commentary or markdown:\n" +
    '{"score": <0-40>, "reasoning": "<one sentence>"}';
  const user = JSON.stringify({
    alert: item.input.alert,
    recipient_role: item.input.recipient_role,
    tone: item.input.tone,
    language: item.input.language,
    channel_hint: item.input.channel_hint ?? null,
    composition: output,
  });
  return { system, user };
}

export function buildTelegramJudgePrompt(
  item: ComposeTelegramEvalItem,
  output: ComposeTelegramEvalOutput,
): { system: string; user: string } {
  const system =
    "You are evaluating a Telegram MarkdownV2 alert message. Score on a 0-40 scale across FOUR axes (10 points each):\n" +
    "1. Tone — appropriate for the recipient role and Telegram chat register\n" +
    "2. Factual accuracy — references real fields from the alert\n" +
    "3. MarkdownV2 correctness — reserved chars `_*[](){}.!#+-=|>~` MUST be backslash-escaped wherever they appear as literal text\n" +
    "4. Inline keyboard — when requested, button labels are short and useful (Acknowledge / Open / Silence)\n\n" +
    "Respond with strict JSON, no commentary or markdown:\n" +
    '{"score": <0-40>, "reasoning": "<one sentence>"}';
  const sanitized: ComposeTelegramEvalInput & {
    composition: ComposeTelegramEvalOutput;
  } = {
    ...item.input,
    composition: output,
  };
  const user = JSON.stringify(sanitized);
  return { system, user };
}

export function buildPushJudgePrompt(
  item: ComposePushEvalItem,
  output: ComposePushEvalOutput,
): { system: string; user: string } {
  const system =
    "You are evaluating a mobile push notification. Score on a 0-40 scale across FOUR axes (10 points each):\n" +
    "1. Title — urgent and specific (the lockscreen sees this), <= 50 chars\n" +
    "2. Body — communicates impact in <= 200 chars\n" +
    "3. Actions — when present, ids are slugs and titles are clear OS-affordable verbs\n" +
    "4. Category — picked from the documented enum or null\n\n" +
    "Respond with strict JSON, no commentary or markdown:\n" +
    '{"score": <0-40>, "reasoning": "<one sentence>"}';
  const user = JSON.stringify({
    alert: item.input.alert,
    platform: item.input.platform ?? "ios",
    language: item.input.language,
    composition: output,
  });
  return { system, user };
}
