/**
 * v0.3 S3 — production wrapper around the @inariwatch/ai-router eval CLI.
 *
 * Usage:
 *   npx tsx web/scripts/run-eval.ts \
 *     --task notify.compose.email \
 *     --substrate user-sidecar \
 *     --limit 5
 *
 * Differences from `packages/ai-router/src/eval/run.ts`:
 *   - Picks up PLATFORM_AI_KEY from web's .env.local (via dotenv-style env).
 *   - Pretty-prints + writes the report to `web/.eval-output/<ts>.json`
 *     so /admin/ai-eval can render history without a DB hop.
 *   - Logs a one-line summary the smoke loop greps to decide ship/no-ship.
 *
 * Adding a new substrate to compare? Run twice with different
 * --substrate flags and diff the JSON output.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  NOTIFY_COMPOSE_EMAIL_CORPUS,
  TASKS,
  dispatch,
  makeGpt4oMiniJudge,
  runEval,
  type ComposeEmailEvalItem,
  type EvalReport,
  type Substrate,
} from "@inariwatch/ai-router";

interface CliOpts {
  substrate: Substrate;
  model: string | null;
  apiKey: string;
  limit: number | null;
  outDir: string;
}

function parseArgs(argv: string[]): CliOpts {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i++;
    } else {
      map.set(key, "true");
    }
  }
  const substrate = (map.get("substrate") ?? "cloud") as Substrate;
  if (!["cloud", "user-sidecar"].includes(substrate)) {
    throw new Error(`--substrate must be cloud|user-sidecar (got ${substrate})`);
  }
  const apiKey =
    map.get("api-key") ??
    process.env.PLATFORM_AI_KEY ??
    process.env.OPENAI_API_KEY ??
    "";
  if (!apiKey) {
    throw new Error(
      "API key required: pass --api-key, or set PLATFORM_AI_KEY / OPENAI_API_KEY",
    );
  }
  return {
    substrate,
    model: map.get("model") ?? null,
    apiKey,
    limit: map.get("limit") ? Number.parseInt(map.get("limit") as string, 10) : null,
    outDir: map.get("out-dir") ?? join(process.cwd(), ".eval-output"),
  };
}

async function dispatchOne(
  item: ComposeEmailEvalItem,
  opts: CliOpts,
) {
  const out = await dispatch({
    mode: "complete",
    task: TASKS.NOTIFY_COMPOSE_EMAIL,
    apiKey: opts.apiKey,
    systemPrompt:
      "You are an incident notifier. Compose an email body for the alert in the user message.",
    messages: [
      {
        role: "user",
        content: buildEvalUserPrompt(item),
      },
    ],
    maxTokens: 512,
    temperature: 0.3,
    jsonMode: true,
    workspace: {
      preferences: {
        taskOverrides: {
          [TASKS.NOTIFY_COMPOSE_EMAIL]:
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
  return {
    output: parseEmailJson(out.response.text),
    modelUsed: out.response.model,
  };
}

function buildEvalUserPrompt(item: ComposeEmailEvalItem): string {
  const i = item.input;
  const languageLabel = i.language === "es" ? "Spanish" : "English";
  const toneGuidance =
    i.tone === "detailed"
      ? "include a one-paragraph context section and 2-3 recommended next steps"
      : "be concise — 2 short sentences max";
  const roleGuidance =
    i.recipient_role === "manager"
      ? "Frame impact in business terms; avoid stack traces and code-level detail."
      : i.recipient_role === "stakeholder"
        ? "Plain language; explain what users see, no internal jargon."
        : "Technical detail OK; reference stack-trace fragments when useful.";
  return [
    `Language: ${languageLabel}.`,
    `Tone: ${toneGuidance}.`,
    `Recipient role: ${i.recipient_role}. ${roleGuidance}`,
    "",
    `Alert title: ${i.alert.title}`,
    `Severity: ${i.alert.severity}`,
    `Source: ${i.alert.source}`,
    `Detail: ${i.alert.message ?? "(no detail)"}`,
    `Link: ${i.alert.url ?? ""}`,
    "",
    "Respond with strict JSON, exactly this shape and no commentary or markdown fences:",
    '{"subject": "<one line subject, <=80 chars>", "body": "<email body, plain text>", "suggested_actions": ["<short action>", "<short action>"]}',
  ].join("\n");
}

function parseEmailJson(raw: string): {
  subject: string;
  body: string;
  suggested_actions: string[];
} {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`malformed eval output (no JSON braces): ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  return {
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    suggested_actions: Array.isArray(parsed.suggested_actions)
      ? (parsed.suggested_actions.filter((s) => typeof s === "string") as string[])
      : [],
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = opts.limit
    ? NOTIFY_COMPOSE_EMAIL_CORPUS.slice(0, opts.limit)
    : NOTIFY_COMPOSE_EMAIL_CORPUS;

  console.log(
    `[eval] task=notify.compose.email substrate=${opts.substrate} n=${corpus.length}`,
  );
  const judge = makeGpt4oMiniJudge({ apiKey: opts.apiKey });
  const startedAt = new Date();
  const report: EvalReport = await runEval({
    corpus,
    substrate: opts.substrate,
    task: TASKS.NOTIFY_COMPOSE_EMAIL,
    judge,
    dispatchFn: (item) => dispatchOne(item, opts),
  });

  // Persist alongside web's runtime artifacts; .gitignored by default.
  mkdirSync(opts.outDir, { recursive: true });
  const ts = startedAt.toISOString().replace(/[:.]/g, "-");
  const outPath = join(
    opts.outDir,
    `${ts}.notify-compose-email.${opts.substrate}.json`,
  );
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `[eval] mean=${report.mean_score.toFixed(1)} passed=${report.passed} -> ${outPath}`,
  );
}

main().catch((e) => {
  console.error("[eval] failed:", e);
  process.exit(1);
});
