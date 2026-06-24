// Together AI provider adapter.
// THE ONLY FILE allowed to talk to api.together.xyz.
// Together speaks the OpenAI-compatible Chat Completions shape. The
// active per-task routing (which model gets which AITask) is decided
// upstream in `web/lib/ai/together-routing.ts` — see the bucket list
// there (CHAT_ORCH / ANALYSIS / CLASSIFY / APPLY / ASSIST / ALERT /
// CODE / FIX). The `defaultModel` constant below is ONLY a fallback
// for callers that omit `opts.model`; production callers always pass
// an explicit model, so the value here is a safety net, not a routing
// decision. Pinned to Qwen3.5-9B-FP8 (cheap, always-available on the
// Together serverless catalog) as of Phase 4.6 of the pure-slash
// refactor (2026-05-15) — the previous default Qwen/Qwen2.5-Coder-32B-
// Instruct is no longer in the catalog.

import type {
  AIResponse,
  CompleteOpts,
  StreamCompleteOpts,
  StreamCompleteResult,
  ToolUseOpts,
  ToolUseProviderResult,
  ValidateKeyResult,
  VisionOpts,
} from "./types";
import {
  runComplete as compatComplete,
  runWithTools as compatWithTools,
  runStreamComplete as compatStreamComplete,
  runValidateKey as compatValidateKey,
} from "./_openai-compat-shared";

const CFG = {
  baseUrl: "https://api.together.xyz/v1",
  provider: "together" as const,
  defaultModel: "Qwen/Qwen3.5-9B-FP8",
};

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  return compatComplete(opts, CFG);
}

export async function withTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  return compatWithTools(opts, CFG);
}

export async function vision(opts: VisionOpts): Promise<never> {
  // Together hosts vision models (LLaVA, Llama-Vision) but our routing
  // table consumes text-only models only (see `together-routing.ts`
  // buckets). Surfacing an explicit error keeps callers from accidentally
  // routing vision to a text-only model — they should fall back to
  // OpenAI vision via dispatch.
  void opts;
  throw new Error(
    "Together adapter is text-only by design; route vision to OpenAI",
  );
}

export function streamComplete(opts: StreamCompleteOpts): StreamCompleteResult {
  return compatStreamComplete(opts, CFG);
}

export async function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return compatValidateKey(
    apiKey,
    CFG,
    "Invalid Together AI API key — replace it in Settings → AI",
  );
}
