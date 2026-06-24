// v0.3 S3 — eval CLI runner.
//
// Usage (workspace internal — NOT a published bin):
//   npx tsx packages/ai-router/src/eval/run.ts \
//     --task notify.compose.email \
//     --substrate user-sidecar \
//     --model qwen2.5-coder-1.5b
//
// Reads PLATFORM_AI_KEY (or OPENAI_API_KEY) for both the production
// dispatch path AND the GPT-4o-mini judge. RELAY_URL +
// RELAY_DISPATCH_SECRET are required when --substrate=user-sidecar.
//
// Outputs an `EvalReport` JSON to stdout. Wrapper `web/scripts/run-eval.ts`
// adds production-side niceties (DB persistence, /admin/ai-eval upload).

import {
  NOTIFY_COMPOSE_EMAIL_CORPUS,
  type ComposeEmailEvalItem,
  type ComposeEmailEvalInput,
} from "./corpus";
import {
  buildReport,
  makeGpt4oMiniJudge,
  scoreItem,
  scoreItemWith,
  type ComposeEmailEvalOutput,
  type EvalReport,
  type ItemScore,
  type JudgeFn,
} from "./judge";

// v0.3 S4 — channel corpora + per-channel judge prompts/rubrics.
import {
  NOTIFY_COMPOSE_SLACK_CORPUS,
  type ComposeSlackEvalItem,
  type ComposeSlackEvalInput,
} from "./corpus-slack";
import {
  NOTIFY_COMPOSE_TELEGRAM_CORPUS,
  type ComposeTelegramEvalItem,
  type ComposeTelegramEvalInput,
} from "./corpus-telegram";
import {
  NOTIFY_COMPOSE_PUSH_CORPUS,
  type ComposePushEvalItem,
  type ComposePushEvalInput,
} from "./corpus-push";
import {
  buildPushJudgePrompt,
  buildSlackJudgePrompt,
  buildTelegramJudgePrompt,
  scoreRubricPush,
  scoreRubricSlack,
  scoreRubricTelegram,
  type ComposePushEvalOutput,
  type ComposeSlackEvalOutput,
  type ComposeTelegramEvalOutput,
} from "./judge-channels";

import { dispatch } from "../dispatch";
import { TASKS, type TaskName } from "../tasks";
import type { Substrate } from "../rules";

interface CliOpts {
  task: TaskName;
  substrate: Substrate;
  model: string | null;
  apiKey: string;
  /** Optional cap for fast iteration (e.g., --limit 3). */
  limit: number | null;
}

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliOpts {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }
  const taskRaw = (map.get("task") ?? TASKS.NOTIFY_COMPOSE_EMAIL) as TaskName;
  if (!SUPPORTED_TASKS.includes(taskRaw)) {
    throw new Error(
      `--task=${taskRaw} not supported by eval harness; supported: ${SUPPORTED_TASKS.join(", ")}`,
    );
  }
  const substrate = (map.get("substrate") ?? "cloud") as Substrate;
  if (!["cloud", "user-sidecar"].includes(substrate)) {
    throw new Error(`--substrate must be cloud|user-sidecar (got ${substrate})`);
  }
  const model = map.get("model") ?? null;
  const apiKey = map.get("api-key") ?? process.env.PLATFORM_AI_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("API key required: pass --api-key, or set PLATFORM_AI_KEY / OPENAI_API_KEY");
  }
  const limitStr = map.get("limit");
  const limit = limitStr ? Number.parseInt(limitStr, 10) : null;
  return { task: taskRaw, substrate, model, apiKey, limit };
}

/**
 * Tasks the eval harness covers. S3 launched with email; S4 added the
 * three new local-routed channels. Each entry needs both a corpus and
 * a runner branch in `runEvalForTask`.
 */
export const SUPPORTED_TASKS: readonly TaskName[] = [
  TASKS.NOTIFY_COMPOSE_EMAIL,
  TASKS.NOTIFY_COMPOSE_SLACK,
  TASKS.NOTIFY_COMPOSE_TELEGRAM,
  TASKS.NOTIFY_COMPOSE_PUSH,
] as const;

// ── Dispatcher (per substrate) ─────────────────────────────────────────────

/**
 * Invoke the router for one corpus item and translate the response into the
 * eval output shape. Throws if the dispatch returns malformed JSON — those
 * count as a 0 in the runner since the parser would reject anyway.
 */
async function dispatchOne(
  item: ComposeEmailEvalItem,
  opts: CliOpts,
): Promise<{ output: ComposeEmailEvalOutput; modelUsed: string }> {
  const promptInput = buildComposeEmailPayload(item.input);
  const out = await dispatch({
    mode: "complete",
    task: opts.task,
    apiKey: opts.apiKey,
    systemPrompt: promptInput.system,
    messages: [{ role: "user", content: promptInput.user }],
    maxTokens: 512,
    temperature: 0.3,
    jsonMode: true,
    workspace: {
      // Force the requested substrate via preferences.taskOverrides — the
      // eval harness is the one place where bypassing the workspaceFlag
      // gate is correct (we're explicitly measuring the local-vs-cloud
      // difference, not respecting opt-in).
      preferences: {
        taskOverrides: {
          [opts.task]:
            opts.substrate === "user-sidecar"
              ? {
                  substrate: "user-sidecar",
                  model: opts.model ?? "qwen2.5-coder-1.5b",
                }
              : { substrate: "cloud", model: opts.model ?? undefined },
        },
      },
    },
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  const parsed = parseEmailJson(out.response.text);
  return {
    output: parsed,
    modelUsed: out.response.model,
  };
}

/**
 * Build the cloud prompt for `notify.compose.email`. Mirrors the
 * desktop-side `notify_compose::build_prompt` byte-for-byte so cross-
 * substrate eval scores aren't confounded by template drift. The
 * desktop version is the SSOT — keep these in sync when extending.
 */
function buildComposeEmailPayload(input: ComposeEmailEvalInput): {
  system: string;
  user: string;
} {
  const languageLabel = input.language === "es" ? "Spanish" : "English";
  const toneGuidance =
    input.tone === "detailed"
      ? "include a one-paragraph context section and 2-3 recommended next steps"
      : "be concise — 2 short sentences max";
  const roleGuidance =
    input.recipient_role === "manager"
      ? "Frame impact in business terms; avoid stack traces and code-level detail."
      : input.recipient_role === "stakeholder"
        ? "Plain language; explain what users see, no internal jargon."
        : "Technical detail OK; reference stack-trace fragments when useful.";
  const system =
    "You are an incident notifier. Compose an email body for the alert in the user message.";
  const user = [
    `Language: ${languageLabel}.`,
    `Tone: ${toneGuidance}.`,
    `Recipient role: ${input.recipient_role}. ${roleGuidance}`,
    "",
    `Alert title: ${input.alert.title}`,
    `Severity: ${input.alert.severity}`,
    `Source: ${input.alert.source}`,
    `Detail: ${input.alert.message ?? "(no detail)"}`,
    `Link: ${input.alert.url ?? ""}`,
    "",
    'Respond with strict JSON, exactly this shape and no commentary or markdown fences:',
    '{"subject": "<one line subject, <=80 chars>", "body": "<email body, plain text>", "suggested_actions": ["<short action>", "<short action>"]}',
  ].join("\n");
  return { system, user };
}

function parseEmailJson(raw: string): ComposeEmailEvalOutput {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`malformed eval output (no JSON braces): ${truncate(raw)}`);
  }
  const slice = raw.slice(start, end + 1);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(slice) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `malformed eval output (JSON parse): ${(e as Error).message}: ${truncate(slice)}`,
    );
  }
  return {
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    suggested_actions: Array.isArray(parsed.suggested_actions)
      ? (parsed.suggested_actions.filter((s) => typeof s === "string") as string[])
      : [],
  };
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Run the eval. Visible for tests so the harness can be exercised with a
 * mock judge / canned dispatch outputs without spinning up real
 * providers.
 *
 * v0.3 S3 used this with `ComposeEmailEvalItem` corpora directly. v0.3
 * S4 made the function generic so the same loop drives the slack /
 * telegram / push corpora — caller passes its own typed dispatchFn +
 * scoring closure. The default type params keep the email call sites
 * working without changes.
 */
export async function runEval<
  TItem extends { id: string } = ComposeEmailEvalItem,
  TOutput = ComposeEmailEvalOutput,
>(opts: {
  corpus: TItem[];
  substrate: Substrate;
  task: TaskName;
  judge: JudgeFn<TItem, TOutput>;
  /** Returns a (composition, modelUsed) for one corpus item. */
  dispatchFn: (item: TItem) => Promise<{ output: TOutput; modelUsed: string }>;
  /**
   * Per-item rubric + judge combiner. Defaults to the S3 email
   * `scoreItem` (which calls `scoreRubric` against the email rubric).
   * S4 channel runners pass their own scorer that calls the channel-
   * specific rubric (`scoreRubricSlack`, etc.) from `judge-channels.ts`.
   */
  scorer?: (
    item: TItem,
    output: TOutput,
    judge: JudgeFn<TItem, TOutput>,
  ) => Promise<ItemScore>;
}): Promise<EvalReport> {
  const examples: ItemScore[] = [];
  let modelUsed: string | null = null;
  // Default scorer is the email-typed scoreItem. Cast is safe at the
  // call site for default email type params; channel runners pass their
  // own scorer so this fallback doesn't fire.
  const scorer =
    opts.scorer ??
    ((
      i: TItem,
      o: TOutput,
      j: JudgeFn<TItem, TOutput>,
    ) =>
      scoreItem(
        i as unknown as ComposeEmailEvalItem,
        o as unknown as ComposeEmailEvalOutput,
        j as unknown as JudgeFn,
      ));
  for (const item of opts.corpus) {
    try {
      const r = await opts.dispatchFn(item);
      modelUsed = r.modelUsed;
      const score = await scorer(item, r.output, opts.judge);
      examples.push(score);
    } catch (e) {
      examples.push({
        id: item.id,
        score: 0,
        rubricScore: 0,
        judgeScore: 0,
        rubricFailures: [`dispatch failed: ${(e as Error).message}`],
        judgeReasoning: undefined,
      });
    }
  }
  return buildReport({
    task: opts.task,
    substrate: opts.substrate,
    model: modelUsed,
    examples,
  });
}

// ── v0.3 S4 — per-task dispatch helpers ───────────────────────────────────

/**
 * v0.3 S4 — dispatch helpers for the slack / telegram / push tasks.
 *
 * Each builds a cloud-side prompt that mirrors the channel's desktop
 * `build_prompt` byte-for-byte. The eval harness uses
 * `taskOverrides` to force the substrate the same way the email
 * runner does.
 */
async function dispatchOneSlack(
  item: ComposeSlackEvalItem,
  opts: CliOpts,
): Promise<{ output: ComposeSlackEvalOutput; modelUsed: string }> {
  const promptInput = buildComposeSlackPayload(item.input);
  const out = await dispatch({
    mode: "complete",
    task: opts.task,
    apiKey: opts.apiKey,
    systemPrompt: promptInput.system,
    messages: [{ role: "user", content: promptInput.user }],
    maxTokens: 512,
    temperature: 0.3,
    jsonMode: true,
    workspace: workspaceOverride(opts),
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  return {
    output: parseSlackJson(out.response.text),
    modelUsed: out.response.model,
  };
}

async function dispatchOneTelegram(
  item: ComposeTelegramEvalItem,
  opts: CliOpts,
): Promise<{ output: ComposeTelegramEvalOutput; modelUsed: string }> {
  const promptInput = buildComposeTelegramPayload(item.input);
  const out = await dispatch({
    mode: "complete",
    task: opts.task,
    apiKey: opts.apiKey,
    systemPrompt: promptInput.system,
    messages: [{ role: "user", content: promptInput.user }],
    maxTokens: 512,
    temperature: 0.3,
    jsonMode: true,
    workspace: workspaceOverride(opts),
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  return {
    output: parseTelegramJson(out.response.text),
    modelUsed: out.response.model,
  };
}

async function dispatchOnePush(
  item: ComposePushEvalItem,
  opts: CliOpts,
): Promise<{ output: ComposePushEvalOutput; modelUsed: string }> {
  const promptInput = buildComposePushPayload(item.input);
  const out = await dispatch({
    mode: "complete",
    task: opts.task,
    apiKey: opts.apiKey,
    systemPrompt: promptInput.system,
    messages: [{ role: "user", content: promptInput.user }],
    maxTokens: 256,
    temperature: 0.3,
    jsonMode: true,
    workspace: workspaceOverride(opts),
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  return {
    output: parsePushJson(out.response.text),
    modelUsed: out.response.model,
  };
}

/** Shared workspace override builder. Picks the `taskOverrides` shape
 * that pins the requested substrate for the active CLI run. Mirrors the
 * email runner's logic — the comment there explains why bypassing the
 * workspaceFlag is correct in eval. */
function workspaceOverride(opts: CliOpts) {
  return {
    preferences: {
      taskOverrides: {
        [opts.task]:
          opts.substrate === "user-sidecar"
            ? {
                substrate: "user-sidecar" as const,
                model: opts.model ?? "qwen2.5-coder-1.5b",
              }
            : { substrate: "cloud" as const, model: opts.model ?? undefined },
      },
    },
  };
}

// ── Per-channel cloud prompt builders + JSON parsers ─────────────────────

function buildComposeSlackPayload(input: ComposeSlackEvalInput): {
  system: string;
  user: string;
} {
  const languageLabel = input.language === "es" ? "Spanish" : "English";
  const toneGuidance =
    input.tone === "detailed"
      ? "include a 2-3 sentence context paragraph in the section block"
      : "be concise — the section text should be 2 short sentences max";
  const roleGuidance =
    input.recipient_role === "manager"
      ? "Frame impact in business terms; avoid stack traces and code-level detail."
      : input.recipient_role === "stakeholder"
        ? "Plain language; explain what users see, no internal jargon."
        : "Technical detail OK; reference stack-trace fragments when useful.";
  const mentionGuidance = input.allow_here_mention
    ? "If severity is `critical`, you MAY include `<!here>` as the first token of the section text. Otherwise do NOT include any channel mentions."
    : "Do NOT include any channel mentions (`<!here>`, `<!channel>`).";
  const channel = input.channel_hint ?? "(channel unknown)";
  const system =
    "You are an incident notifier composing a Slack Block-Kit message.";
  const user = [
    `Language: ${languageLabel}.`,
    `Tone: ${toneGuidance}.`,
    `Recipient role: ${input.recipient_role}. ${roleGuidance}`,
    `Channel hint: ${channel}. ${mentionGuidance}`,
    "",
    `Alert title: ${input.alert.title}`,
    `Severity: ${input.alert.severity}`,
    `Source: ${input.alert.source}`,
    `Detail: ${input.alert.message ?? "(no detail)"}`,
    `Link: ${input.alert.url ?? ""}`,
    "",
    "Slack mrkdwn rules — escape `&` as `&amp;`, `<` as `&lt;`, `>` as `&gt;` only when literal text. Use `*bold*`, `_italic_`, `\\`code\\``, `<url|label>`. Never wrap in markdown fences.",
    "",
    'Respond with strict JSON: {"text": "<<=140 chars preview>", "blocks": [{"type":"section","text":{"type":"mrkdwn","text":"<the body>"}}]}',
  ].join("\n");
  return { system, user };
}

function buildComposeTelegramPayload(input: ComposeTelegramEvalInput): {
  system: string;
  user: string;
} {
  const languageLabel = input.language === "es" ? "Spanish" : "English";
  const toneGuidance =
    input.tone === "detailed"
      ? "include a 2-3 sentence context paragraph"
      : "be concise — 2 short sentences max";
  const roleGuidance =
    input.recipient_role === "manager"
      ? "Frame impact in business terms; avoid stack traces and code-level detail."
      : input.recipient_role === "stakeholder"
        ? "Plain language; explain what users see, no internal jargon."
        : "Technical detail OK; reference stack-trace fragments when useful.";
  const buttonsClause = input.include_inline_buttons
    ? "Add an inline_keyboard with 2 buttons: callback_data \"ack\" labelled like \"Acknowledge\", and the alert URL labelled like \"Open alert\"."
    : "Set inline_keyboard to null.";
  const system =
    "You are an incident notifier composing a Telegram MarkdownV2 message.";
  const user = [
    `Language: ${languageLabel}.`,
    `Tone: ${toneGuidance}.`,
    `Recipient role: ${input.recipient_role}. ${roleGuidance}`,
    "",
    `Alert title: ${input.alert.title}`,
    `Severity: ${input.alert.severity}`,
    `Source: ${input.alert.source}`,
    `Detail: ${input.alert.message ?? "(no detail)"}`,
    `Link: ${input.alert.url ?? ""}`,
    "",
    "Telegram MarkdownV2 rules — these characters MUST be backslash-escaped wherever they appear as literal text: _ * [ ] ( ) ~ ` > # + - = | { } . !",
    "Use *bold*, _italic_, `code`, [label](url). Keep body under 1500 chars.",
    "",
    buttonsClause,
    "",
    'Respond with strict JSON: {"text": "<MarkdownV2 body>", "parse_mode": "MarkdownV2", "inline_keyboard": null}',
  ].join("\n");
  return { system, user };
}

function buildComposePushPayload(input: ComposePushEvalInput): {
  system: string;
  user: string;
} {
  const languageLabel = input.language === "es" ? "Spanish" : "English";
  const platform = input.platform ?? "ios";
  const platformGuidance =
    platform === "android"
      ? "Android lockscreens show ~80 chars of body — fit the urgency in the first line."
      : platform === "web"
        ? "Web Push allows longer bodies; you may use the full 200-char budget."
        : "iOS lockscreens show ~60 chars of body — fit the urgency in the first line.";
  const actionsClause = input.suggest_actions
    ? "Include 1-3 quick actions in `actions`. Suggested ids: \"ack\", \"open\", \"silence\"."
    : "Set actions to an empty array.";
  const system =
    "You are an incident notifier composing a mobile push notification.";
  const user = [
    `Language: ${languageLabel}.`,
    `Platform: ${platform}. ${platformGuidance}`,
    "",
    `Alert title: ${input.alert.title}`,
    `Severity: ${input.alert.severity}`,
    `Source: ${input.alert.source}`,
    `Detail: ${input.alert.message ?? "(no detail)"}`,
    `Link: ${input.alert.url ?? ""}`,
    "",
    "Hard limits: title 50 chars max, body 200 chars max, 0-3 actions (id is a slug).",
    "",
    actionsClause,
    "",
    "Pick a category from: alert.critical, alert.high, alert.warning, alert.info, deploy.failed, deploy.rolled_back, uptime.down, uptime.recovered (or null).",
    "",
    'Respond with strict JSON: {"title":"<short>","body":"<one-or-two-line>","actions":[{"id":"<slug>","title":"<UI label>"}],"category":"<allowed value or null>"}',
  ].join("\n");
  return { system, user };
}

function parseSlackJson(raw: string): ComposeSlackEvalOutput {
  const parsed = parseFirstJson(raw);
  return {
    text: typeof parsed.text === "string" ? parsed.text : "",
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
  };
}
function parseTelegramJson(raw: string): ComposeTelegramEvalOutput {
  const parsed = parseFirstJson(raw);
  const inline_keyboard = Array.isArray(parsed.inline_keyboard)
    ? (parsed.inline_keyboard as Array<Array<unknown>>)
    : null;
  return {
    text: typeof parsed.text === "string" ? parsed.text : "",
    parse_mode:
      typeof parsed.parse_mode === "string" ? parsed.parse_mode : "MarkdownV2",
    inline_keyboard,
  };
}
function parsePushJson(raw: string): ComposePushEvalOutput {
  const parsed = parseFirstJson(raw);
  const actions = Array.isArray(parsed.actions)
    ? (parsed.actions as Array<Record<string, unknown>>)
        .filter(
          (a) =>
            typeof a.id === "string" &&
            typeof a.title === "string",
        )
        .map((a) => ({
          id: a.id as string,
          title: a.title as string,
        }))
    : [];
  return {
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    actions,
    category: typeof parsed.category === "string" ? parsed.category : null,
  };
}
function parseFirstJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`malformed eval output (no JSON braces): ${truncate(raw)}`);
  }
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `malformed eval output (JSON parse): ${(e as Error).message}: ${truncate(slice)}`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const judge = makeGpt4oMiniJudge({ apiKey: opts.apiKey });
  let report: EvalReport;
  switch (opts.task) {
    case TASKS.NOTIFY_COMPOSE_EMAIL: {
      const corpus = opts.limit
        ? NOTIFY_COMPOSE_EMAIL_CORPUS.slice(0, opts.limit)
        : NOTIFY_COMPOSE_EMAIL_CORPUS;
      report = await runEval({
        corpus,
        substrate: opts.substrate,
        task: opts.task,
        judge,
        dispatchFn: (item) => dispatchOne(item, opts),
      });
      break;
    }
    case TASKS.NOTIFY_COMPOSE_SLACK: {
      const corpus = opts.limit
        ? NOTIFY_COMPOSE_SLACK_CORPUS.slice(0, opts.limit)
        : NOTIFY_COMPOSE_SLACK_CORPUS;
      // Slack judge — wraps the GPT-4o-mini path with the channel-specific
      // system prompt (built in `judge-channels.ts`).
      const slackJudge: JudgeFn<ComposeSlackEvalItem, ComposeSlackEvalOutput> =
        makeChannelJudge({
          apiKey: opts.apiKey,
          buildPrompt: (i, o) => buildSlackJudgePrompt(i, o),
        });
      report = await runEval<ComposeSlackEvalItem, ComposeSlackEvalOutput>({
        corpus,
        substrate: opts.substrate,
        task: opts.task,
        judge: slackJudge,
        dispatchFn: (item) => dispatchOneSlack(item, opts),
        scorer: async (item, output, judge) => {
          const rubric = scoreRubricSlack(item.rubric, output);
          return scoreItemWith(item, output, rubric, judge);
        },
      });
      break;
    }
    case TASKS.NOTIFY_COMPOSE_TELEGRAM: {
      const corpus = opts.limit
        ? NOTIFY_COMPOSE_TELEGRAM_CORPUS.slice(0, opts.limit)
        : NOTIFY_COMPOSE_TELEGRAM_CORPUS;
      const tgJudge: JudgeFn<
        ComposeTelegramEvalItem,
        ComposeTelegramEvalOutput
      > = makeChannelJudge({
        apiKey: opts.apiKey,
        buildPrompt: (i, o) => buildTelegramJudgePrompt(i, o),
      });
      report = await runEval<
        ComposeTelegramEvalItem,
        ComposeTelegramEvalOutput
      >({
        corpus,
        substrate: opts.substrate,
        task: opts.task,
        judge: tgJudge,
        dispatchFn: (item) => dispatchOneTelegram(item, opts),
        scorer: async (item, output, judge) => {
          const rubric = scoreRubricTelegram(item.rubric, output);
          return scoreItemWith(item, output, rubric, judge);
        },
      });
      break;
    }
    case TASKS.NOTIFY_COMPOSE_PUSH: {
      const corpus = opts.limit
        ? NOTIFY_COMPOSE_PUSH_CORPUS.slice(0, opts.limit)
        : NOTIFY_COMPOSE_PUSH_CORPUS;
      const pushJudge: JudgeFn<ComposePushEvalItem, ComposePushEvalOutput> =
        makeChannelJudge({
          apiKey: opts.apiKey,
          buildPrompt: (i, o) => buildPushJudgePrompt(i, o),
        });
      report = await runEval<ComposePushEvalItem, ComposePushEvalOutput>({
        corpus,
        substrate: opts.substrate,
        task: opts.task,
        judge: pushJudge,
        dispatchFn: (item) => dispatchOnePush(item, opts),
        scorer: async (item, output, judge) => {
          const rubric = scoreRubricPush(item.rubric, output);
          return scoreItemWith(item, output, rubric, judge);
        },
      });
      break;
    }
    default:
      throw new Error(`unsupported task: ${opts.task}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Build a per-channel GPT-4o-mini judge. Identical wire shape to
 * `makeGpt4oMiniJudge` but lets the caller plug a channel-specific
 * system prompt. Kept narrow on purpose — the public-API
 * `makeGpt4oMiniJudge` stays the email-only "default" so existing
 * imports don't need to learn channels.
 */
function makeChannelJudge<TItem, TOutput>(opts: {
  apiKey: string;
  buildPrompt: (
    item: TItem,
    output: TOutput,
  ) => { system: string; user: string };
  baseUrl?: string;
  fetcher?: typeof fetch;
  model?: string;
}): JudgeFn<TItem, TOutput> {
  const fetchImpl = opts.fetcher ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const model = opts.model ?? "gpt-4o-mini";
  return async (item, output) => {
    const { system, user } = opts.buildPrompt(item, output);
    const res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      throw new Error(`judge http ${res.status}`);
    }
    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    let parsed: { score?: number; reasoning?: string };
    try {
      parsed = JSON.parse(raw) as { score?: number; reasoning?: string };
    } catch {
      throw new Error(`judge returned non-JSON: ${raw.slice(0, 200)}`);
    }
    const score = clampN(toN(parsed.score, 0), 0, 40);
    return {
      score,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  };
}

function clampN(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function toN(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

const isMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /run\.ts$/.test(process.argv[1] ?? "");
if (isMain) {
  main().catch((e) => {
    console.error("eval failed:", e);
    process.exit(1);
  });
}
