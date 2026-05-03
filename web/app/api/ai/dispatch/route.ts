// v0.3 S7 — `/api/ai/dispatch` proxy endpoint.
//
// Rust callers (`crates/ai-router-rs/src/adapters/cloud_proxy.rs` in
// Proxy mode) POST here to dispatch an AI call through the canonical
// router (`packages/ai-router`). The web side resolves the actual
// provider key (BYOK from `apiKeys` table OR PLATFORM_AI_KEY env var)
// and forwards into TS `dispatch()`.
//
// Auth:
// - `Authorization: Bearer <token>` where token matches an
//   `apiKeys` row with service in {desktop, cli}. Mirrors the existing
//   `/api/desktop/alerts` and CLI auth patterns. SHA-256 timing-safe
//   compare against the decrypted stored key (matches the existing
//   pattern — when the codebase migrates to hashed tokens, this route
//   migrates with it).
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
import crypto from "crypto";

import { db, apiKeys, projects } from "@/lib/db";
import { eq, inArray } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import {
  dispatch,
  dispatchStream,
  ALL_TASKS,
  type AIProvider,
  type DispatchComplete,
  type DispatchStreamInput,
  type TaskName,
  type WorkspaceContext,
} from "@inariwatch/ai-router";
import { getPlatformOpenAIKey } from "@/lib/ai/get-key";

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
}

const ALLOWED_PROVIDERS: ReadonlySet<AIProvider> = new Set<AIProvider>([
  "openai",
  "claude",
  "groq",
  "grok",
  "deepseek",
  "gemini",
]);

const ALLOWED_TASKS = new Set<string>(ALL_TASKS as readonly string[]);

async function authenticate(req: NextRequest): Promise<{ userId: string } | NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = auth.slice(7).trim();
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(apiKeys)
    .where(inArray(apiKeys.service, ["desktop", "cli"] as const));
  const provided = Buffer.from(token);

  const keyRow = rows.find((k) => {
    let stored: Buffer;
    try {
      stored = Buffer.from(decrypt(k.keyEncrypted ?? ""));
    } catch {
      return false;
    }
    if (stored.length !== provided.length) return false;
    return crypto.timingSafeEqual(stored, provided);
  });

  if (!keyRow) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  return { userId: keyRow.userId };
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
  const provider = (parsed.provider ?? undefined) as AIProvider | undefined;

  if (parsed.mode === "complete") {
    const input: DispatchComplete = {
      mode: "complete",
      task,
      apiKey: apiKey.key,
      systemPrompt: parsed.system_prompt,
      messages: parsed.messages,
      maxTokens: parsed.max_tokens,
      model: parsed.model ?? undefined,
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
    apiKey: apiKey.key,
    systemPrompt: parsed.system_prompt,
    messages: parsed.messages,
    maxTokens: parsed.max_tokens,
    model: parsed.model ?? undefined,
    temperature: parsed.temperature ?? undefined,
    jsonMode: parsed.json_mode ?? undefined,
    provider,
    workspace,
  };
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of dispatchStream(input)) {
          const payload = chunk.done
            ? {
                delta: "",
                done: true,
                usage: chunk.receipt
                  ? {
                      input_tokens: chunk.receipt.inputTokens ?? 0,
                      output_tokens: chunk.receipt.outputTokens ?? 0,
                      cached_input_tokens: chunk.receipt.cachedInputTokens ?? 0,
                    }
                  : undefined,
                model: chunk.receipt?.model ?? "",
              }
            : { delta: chunk.delta, done: false };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`,
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
