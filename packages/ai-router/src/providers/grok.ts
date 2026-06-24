// xAI Grok provider adapter.
// THE ONLY FILE allowed to talk to api.x.ai.
// Grok speaks the OpenAI-compatible Chat Completions shape.

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
  baseUrl: "https://api.x.ai/v1",
  provider: "grok" as const,
  defaultModel: "grok-4-fast",
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
  return compatVision(opts, CFG);
}

export function streamComplete(opts: StreamCompleteOpts): StreamCompleteResult {
  return compatStreamComplete(opts, CFG);
}

export async function validateKey(apiKey: string): Promise<ValidateKeyResult> {
  return compatValidateKey(
    apiKey,
    CFG,
    "Invalid Grok (xAI) API key — replace it in Settings → AI",
  );
}
