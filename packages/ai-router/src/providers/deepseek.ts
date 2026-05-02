// DeepSeek provider adapter.
// THE ONLY FILE allowed to talk to api.deepseek.com.

import type {
  AIResponse,
  CompleteOpts,
  ToolUseOpts,
  ToolUseProviderResult,
  VisionOpts,
} from "./types";
import {
  runComplete as compatComplete,
  runWithTools as compatWithTools,
} from "./_openai-compat-shared";

const CFG = {
  baseUrl: "https://api.deepseek.com/v1",
  provider: "deepseek" as const,
  defaultModel: "deepseek-chat",
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
  void opts;
  throw new Error(
    "DeepSeek does not support vision; route to a vision-capable provider",
  );
}
