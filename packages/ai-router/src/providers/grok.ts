// xAI Grok provider adapter.
// THE ONLY FILE allowed to talk to api.x.ai.
// Grok speaks the OpenAI-compatible Chat Completions shape.

import type {
  AIResponse,
  CompleteOpts,
  ToolUseOpts,
  ToolUseProviderResult,
  VisionOpts,
  VisionProviderResult,
} from "./types";
import {
  runComplete as compatComplete,
  runWithTools as compatWithTools,
  runVision as compatVision,
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
