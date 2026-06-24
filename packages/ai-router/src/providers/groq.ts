// Groq provider adapter.
// THE ONLY FILE allowed to talk to api.groq.com.
// Groq speaks the OpenAI-compatible Chat Completions shape and is the
// fastest hosted Llama provider — used as the cheap Tier 0 in the cascade.

import type {
  AIResponse,
  CompleteOpts,
  StreamCompleteOpts,
  StreamCompleteResult,
  ToolUseOpts,
  ToolUseProviderResult,
  ValidateKeyResult,
  VisionOpts,
  VisionProviderResult,
} from "./types";
import {
  runComplete as compatComplete,
  runWithTools as compatWithTools,
  runVision as compatVision,
  runStreamComplete as compatStreamComplete,
  runValidateKey as compatValidateKey,
} from "./_openai-compat-shared";

const CFG = {
  baseUrl: "https://api.groq.com/openai/v1",
  provider: "groq" as const,
  defaultModel: "llama-3.1-8b-instant",
};

export async function complete(opts: CompleteOpts): Promise<AIResponse> {
  return compatComplete(opts, CFG);
}

export async function withTools(
  opts: ToolUseOpts,
): Promise<ToolUseProviderResult> {
  return compatWithTools(opts, CFG);
}

export async function vision(opts: VisionOpts): Promise<VisionProviderResult> {
  // Groq does not ship a vision model in the OpenAI-compatible base. Caller
  // should fall back to text-only via dispatch — we surface a clear error.
  void opts;
  throw new Error("Groq does not support vision; route to a vision-capable provider");
}

export function streamComplete(opts: StreamCompleteOpts): StreamCompleteResult {
  return compatStreamComplete(opts, CFG);
}

export async function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return compatValidateKey(
    apiKey,
    CFG,
    "Invalid Groq API key — replace it in Settings → AI",
  );
}
