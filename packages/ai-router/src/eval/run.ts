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
  type ComposeEmailEvalOutput,
  type EvalReport,
  type ItemScore,
  type JudgeFn,
} from "./judge";

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
  const taskRaw = map.get("task") ?? TASKS.NOTIFY_COMPOSE_EMAIL;
  if (taskRaw !== TASKS.NOTIFY_COMPOSE_EMAIL) {
    throw new Error(
      `--task=${taskRaw} not yet supported by eval harness; only notify.compose.email in S3.`,
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
  return { task: TASKS.NOTIFY_COMPOSE_EMAIL, substrate, model, apiKey, limit };
}

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
 */
export async function runEval(opts: {
  corpus: ComposeEmailEvalItem[];
  substrate: Substrate;
  task: TaskName;
  judge: JudgeFn;
  /** Returns a (composition, modelUsed) for one corpus item. */
  dispatchFn: (
    item: ComposeEmailEvalItem,
  ) => Promise<{ output: ComposeEmailEvalOutput; modelUsed: string }>;
}): Promise<EvalReport> {
  const examples: ItemScore[] = [];
  let modelUsed: string | null = null;
  for (const item of opts.corpus) {
    try {
      const r = await opts.dispatchFn(item);
      modelUsed = r.modelUsed;
      const score = await scoreItem(item, r.output, opts.judge);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = opts.limit
    ? NOTIFY_COMPOSE_EMAIL_CORPUS.slice(0, opts.limit)
    : NOTIFY_COMPOSE_EMAIL_CORPUS;
  const judge = makeGpt4oMiniJudge({ apiKey: opts.apiKey });
  const report = await runEval({
    corpus,
    substrate: opts.substrate,
    task: opts.task,
    judge,
    dispatchFn: (item) => dispatchOne(item, opts),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
