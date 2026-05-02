// Provider adapter registry.
//
// dispatch.ts pulls a provider by name through this index. Files outside
// `packages/ai-router/src/providers/` MUST NOT import any of these modules
// directly — that would bypass the lockdown rule.

import * as anthropic from "./anthropic";
import * as openai from "./openai";
import * as grok from "./grok";
import * as groq from "./groq";
import * as deepseek from "./deepseek";
import * as google from "./google";
import * as userSidecar from "./user-sidecar";

import type { AIProvider } from "../rules";
import type {
  AIResponse,
  CompleteOpts,
  ToolUseOpts,
  ToolUseProviderResult,
  VisionOpts,
  VisionProviderResult,
} from "./types";

export interface ProviderAdapter {
  complete(opts: CompleteOpts): Promise<AIResponse>;
  withTools(opts: ToolUseOpts): Promise<ToolUseProviderResult>;
  vision(opts: VisionOpts): Promise<VisionProviderResult>;
}

export const CLOUD_PROVIDERS: Record<AIProvider, ProviderAdapter> = {
  claude: anthropic,
  openai,
  grok,
  groq,
  deepseek,
  gemini: google,
};

export const SIDECAR = userSidecar;

export { embed as openaiEmbed } from "./openai";
