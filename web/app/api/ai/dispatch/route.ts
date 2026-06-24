// v0.3 S7 — `/api/ai/dispatch` proxy endpoint.
//
// Rust callers (`crates/ai-router-rs/src/adapters/cloud_proxy.rs` in
// Proxy mode) POST here to dispatch an AI call through the canonical
// router (`packages/ai-router`). The web side resolves the actual
// provider key (BYOK from `apiKeys` table OR PLATFORM_AI_KEY env var)
// and forwards into TS `dispatch()`.
//
// Auth:
// - `Authorization: Bearer <token>` resolved by `authenticateExtensionToken`
//   in `web/lib/auth-extension.ts`. That helper checks the modern
//   `device_tokens` table first (Session 1 pairing — what every new
//   desktop install lands in) and falls back to legacy `api_keys` rows
//   with `service ∈ {desktop, cli}` for pre-S1 cohorts. Mirrors the
//   pattern `/api/ai/classify` already uses. The route previously
//   inlined an `api_keys`-only `authenticate()` which 401'd every
//   Session-1 desktop because their token lived in `device_tokens` and
//   never in `api_keys`. The bug surfaced as
//   "OpenAI returned 401: proxy returned 401: Invalid token" in the
//   Inari Live chat bubble even though L2 classification (which uses
//   the correct helper) worked fine for the same user.
//
// Wire shape (mirror of ProxyCompleteRequest in cloud_proxy.rs):
//   {
//     task: "code.fix.single-shot",
//     mode: "complete" | "stream",
//     system_prompt: "...",
//     messages: [{role, content}, ...],
//     max_tokens: 4096,
//     model?: "gpt-4o-mini",
//     temperature?: 0.2,
//     json_mode?: false,
//     provider?: "openai" | "claude" | ...,
//     api_key?: "sk-..."   // BYOK pass-through; falls back to platform key
//   }
//
// Response (complete): JSON
//   { text, model, provider, usage: { input_tokens, output_tokens, cached_input_tokens } }
//
// Response (stream): text/event-stream — `data: {"delta":"...","done":false}` chunks
//   followed by `data: {"delta":"","done":true,"usage":{...},"model":"..."}`.

import { NextRequest, NextResponse } from "next/server";

import { db, projects } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  dispatch,
  dispatchStream,
  ALL_TASKS,
  type AIProvider,
  type DispatchComplete,
  type DispatchStreamInput,
  type TaskName,
  type ToolDefinition,
  type WorkspaceContext,
} from "@inariwatch/ai-router";
import { getPlatformOpenAIKey } from "@/lib/ai/get-key";
import { getTogetherOverride } from "@/lib/ai/together-routing";
import { authenticateExtensionToken } from "@/lib/auth-extension";

type Role = "system" | "user" | "assistant";

interface ProxyMessage {
  role: Role;
  content: string;
}

interface ProxyDispatchBody {
  task: string;
  mode: "complete" | "stream";
  system_prompt: string;
  messages: ProxyMessage[];
  max_tokens: number;
  model?: string | null;
  temperature?: number | null;
  json_mode?: boolean | null;
  provider?: string | null;
  api_key?: string | null;
  /**
   * Function-calling catalog. Honored by the streaming path
   * (mode="stream"); ignored on mode="complete" today. Each entry mirrors
   * `ToolDefinition` (`{ name, description, input_schema }`). Capped at
   * 100 entries to keep request bodies sane.
   */
  tools?: ToolDefinition[] | null;
}

const ALLOWED_PROVIDERS: ReadonlySet<AIProvider> = new Set<AIProvider>([
  "openai",
  "claude",
  "groq",
  "grok",
  "deepseek",
  "gemini",
  // Added 2026-05-15: future Rust callers (and the platform-funded
  // override below) may set provider: "together" explicitly. Without
  // this, the validateBody check at line 130 rejected such requests
  // with HTTP 400. The actual routing still goes through the Together
  // adapter at packages/ai-router/src/providers/together.ts.
  "together",
]);

const ALLOWED_TASKS = new Set<string>(ALL_TASKS as readonly string[]);

async function authenticate(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const result = await authenticateExtensionToken(req);
  if (!result) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  return { userId: result.userId };
}

function validateBody(body: unknown): ProxyDispatchBody | string {
  if (!body || typeof body !== "object") return "body must be an object";
  const b = body as Record<string, unknown>;
  if (typeof b.task !== "string" || !ALLOWED_TASKS.has(b.task)) {
    return `task must be one of ${ALL_TASKS.length} known TaskName values`;
  }
  if (b.mode !== "complete" && b.mode !== "stream") {
    return "mode must be 'complete' or 'stream'";
  }
  if (typeof b.system_prompt !== "string") return "system_prompt must be a string";
  if (!Array.isArray(b.messages)) return "messages must be an array";
  for (const m of b.messages) {
    const mm = m as Record<string, unknown>;
    if (mm.role !== "system" && mm.role !== "user" && mm.role !== "assistant") {
      return "every message.role must be system | user | assistant";
    }
    if (typeof mm.content !== "string") return "every message.content must be a string";
  }
  if (typeof b.max_tokens !== "number" || b.max_tokens <= 0 || b.max_tokens > 32_000) {
    return "max_tokens must be 1..32000";
  }
  if (b.provider && typeof b.provider !== "string") return "provider must be a string";
  if (b.provider && !ALLOWED_PROVIDERS.has(b.provider as AIProvider)) {
    return "provider must be one of openai|claude|groq|grok|deepseek|gemini";
  }
  if (b.tools != null) {
    if (!Array.isArray(b.tools)) return "tools must be an array";
    if (b.tools.length > 100) return "tools must have <= 100 entries";
    for (const t of b.tools) {
      const tt = t as Record<string, unknown>;
      if (typeof tt.name !== "string" || tt.name.length === 0) {
        return "every tool.name must be a non-empty string";
      }
      if (typeof tt.description !== "string") {
        return "every tool.description must be a string";
      }
      if (!tt.input_schema || typeof tt.input_schema !== "object") {
        return "every tool.input_schema must be an object (JSON Schema)";
      }
    }
  }
  return b as unknown as ProxyDispatchBody;
}

async function resolveWorkspace(userId: string): Promise<WorkspaceContext> {
  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId));
  return {
    userId,
    workspaceId: userProjects[0]?.id,
    projectId: userProjects[0]?.id,
  };
}

function pickApiKey(byok: string | null | undefined): { key: string; isPlatform: boolean } | null {
  if (byok && byok.trim().length > 0) {
    return { key: byok, isPlatform: false };
  }
  const platform = getPlatformOpenAIKey();
  if (platform) return { key: platform.key, isPlatform: true };
  return null;
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = validateBody(body);
  if (typeof parsed === "string") {
    return NextResponse.json({ error: parsed }, { status: 400 });
  }

  const apiKey = pickApiKey(parsed.api_key);
  if (!apiKey) {
    return NextResponse.json(
      { error: "No API key (BYOK absent + PLATFORM_AI_KEY not configured)" },
      { status: 500 },
    );
  }

  const workspace = await resolveWorkspace(auth.userId);
  workspace.isPlatformKey = apiKey.isPlatform;

  const task = parsed.task as TaskName;

  // Platform-funded Together routing override.
  //
  // When the override fires (platform-funded user + routed task), it
  // returns `{ key: PLATFORM_TOGETHER_KEY, provider: "together",
  // model: <bucket-mapped-model> }`. The three values are an
  // INSEPARABLE TUPLE — using any of them with another's value
  // mismatches and produces silent cross-provider failures.
  //
  // Live regression that motivated the atomic override: the desktop
  // chat client (Rust `desktop/src-tauri/src/ai/openai.rs:247,276`)
  // hard-codes `input.provider = Some(AIProvider::Openai)` on every
  // request. Previous code here let `parsed.provider` win over the
  // override, so we'd send `provider: "openai"` + the Together key
  // (override's) + the Kimi model name (override's) — the OpenAI
  // adapter then POST'd to `https://api.openai.com/v1/chat/completions`
  // with a `tgp_v1_*` Bearer token, which OpenAI rejected with:
  //
  //   `API error (401): "Incorrect API key provided: tgp_v1_2****9cBg.
  //    You can find your API key at https://platform.openai.com/..."`
  //
  // ATOMIC OVERRIDE PRECEDENCE: when the override fires, ALL THREE
  // override values win. Caller `parsed.*` hints only apply when the
  // override does NOT fire (BYOK users / non-routed tasks).
  const togetherOverride = getTogetherOverride(task, apiKey.isPlatform);
  const effectiveApiKey = togetherOverride?.key ?? apiKey.key;
  const provider = togetherOverride?.provider
    ?? (parsed.provider as AIProvider | undefined);
  const effectiveModel = togetherOverride?.model
    ?? parsed.model
    ?? undefined;

  // ai-router's AIMessage only allows "user" | "assistant"; "system" lives
  // in `systemPrompt`. The proxy's wire format accepts {role: "system"}
  // for parity with OpenAI's chat shape — concatenate any system entries
  // onto the explicit system_prompt before dispatch.
  const systemFromMessages = parsed.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const dispatchMessages = parsed.messages
    .filter((m): m is { role: "user" | "assistant"; content: string } =>
      m.role === "user" || m.role === "assistant",
    );
  const dispatchSystemPrompt =
    systemFromMessages.length > 0
      ? [parsed.system_prompt, systemFromMessages].filter(Boolean).join("\n")
      : parsed.system_prompt;

  if (parsed.mode === "complete") {
    const input: DispatchComplete = {
      mode: "complete",
      task,
      apiKey: effectiveApiKey,
      systemPrompt: dispatchSystemPrompt,
      messages: dispatchMessages,
      maxTokens: parsed.max_tokens,
      model: effectiveModel,
      temperature: parsed.temperature ?? undefined,
      jsonMode: parsed.json_mode ?? undefined,
      provider,
      workspace,
    };
    try {
      const out = await dispatch(input);
      if (out.mode !== "complete") {
        return NextResponse.json(
          { error: "Internal: dispatch returned non-complete shape" },
          { status: 500 },
        );
      }
      return NextResponse.json({
        text: out.response.text,
        model: out.response.model,
        provider: out.response.provider,
        usage: {
          input_tokens: out.response.usage.inputTokens,
          output_tokens: out.response.usage.outputTokens,
          cached_input_tokens: out.response.usage.cachedInputTokens,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Bubble HTTP-status-bearing provider errors with their original
      // status so the Rust side's `should_fallback` can map them
      // accurately (rate-limit vs. 5xx).
      const m = /\((\d{3})\)/.exec(msg);
      const status = m ? Number(m[1]) : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  }

  // mode === "stream" — forward dispatchStream output as SSE.
  const input: DispatchStreamInput = {
    mode: "stream",
    task,
    apiKey: effectiveApiKey,
    systemPrompt: dispatchSystemPrompt,
    messages: dispatchMessages,
    maxTokens: parsed.max_tokens,
    model: effectiveModel,
    temperature: parsed.temperature ?? undefined,
    jsonMode: parsed.json_mode ?? undefined,
    provider,
    workspace,
    tools: parsed.tools ?? undefined,
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of dispatchStream(input)) {
          let payload: Record<string, unknown>;
          if (chunk.done) {
            payload = {
              delta: "",
              done: true,
              // The Rust proxy parser keys on `finish_reason` to decide
              // whether the closure was a normal stop or `tool_calls`
              // (the latter triggers the accumulator-publish path in
              // `desktop/src-tauri/src/ai/streaming.rs`). Default to
              // "stop" so paired clients on the legacy wire keep working.
              finish_reason: chunk.finishReason ?? "stop",
              usage: chunk.receipt
                ? {
                    input_tokens: chunk.receipt.inputTokens ?? 0,
                    output_tokens: chunk.receipt.outputTokens ?? 0,
                    cached_input_tokens: chunk.receipt.cachedInputTokens ?? 0,
                  }
                : undefined,
              model: chunk.receipt?.model ?? "",
            };
          } else if (chunk.toolCall) {
            // Tool-call delta. Wire field names match the Rust
            // `ToolCallDelta` shape (snake_case for `arguments_delta`)
            // so the paired client's serde_json deserialize is direct.
            payload = {
              delta: "",
              done: false,
              tool_call: {
                index: chunk.toolCall.index,
                ...(chunk.toolCall.id !== undefined
                  ? { id: chunk.toolCall.id }
                  : {}),
                ...(chunk.toolCall.name !== undefined
                  ? { name: chunk.toolCall.name }
                  : {}),
                arguments_delta: chunk.toolCall.argsDelta,
              },
            };
          } else {
            payload = { delta: chunk.delta, done: false };
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Emit a parseable `data:` frame instead of `event: error\ndata: {...}`.
        // The Rust SSE parser (cloud_proxy::parse_proxy_frame) only strips the
        // `data:` prefix — an `event:` line tripped serde_json on the rest of
        // the frame and surfaced as "proxy response parse: expected value at
        // line 1 column 1", hiding the real upstream error.
        //
        // The desktop streamer (stream_to_bus) renders `delta` into the chat
        // bubble and closes cleanly on `finish_reason="error"`, so the user
        // now SEES the actual provider/router failure message.
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              delta: `[chat error] ${msg}`,
              done: true,
              finish_reason: "error",
            })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
