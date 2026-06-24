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
import * as together from "./together";
import * as userSidecar from "./user-sidecar";

import type { AIProvider } from "../rules";
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

export interface ProviderAdapter {
  complete(opts: CompleteOpts): Promise<AIResponse>;
  withTools(opts: ToolUseOpts): Promise<ToolUseProviderResult>;
  vision(opts: VisionOpts): Promise<VisionProviderResult>;
  /**
   * Optional — providers without native streaming should omit this and
   * dispatchStream() will fall back to a single-chunk emit from complete().
   * Implementations throw `STREAM_NOT_SUPPORTED` if the path can't run for
   * the given input (e.g., vision/embed don't stream).
   */
  streamComplete?: (opts: StreamCompleteOpts) => StreamCompleteResult;
  /**
   * Light list-models ping. Does NOT call the inference path. Used by
   * Settings → AI Keys to confirm a key is live before persisting.
   */
  validateKey(apiKey: string): Promise<ValidateKeyResult>;
}

export const CLOUD_PROVIDERS: Record<AIProvider, ProviderAdapter> = {
  claude: anthropic,
  openai,
  grok,
  groq,
  deepseek,
  gemini: google,
  together,
};

export const SIDECAR = userSidecar;

export { embed as openaiEmbed } from "./openai";
export { runGrader } from "./openai";

export type { ValidateKeyResult } from "./types";

/**
 * Validate a provider API key without persisting it. Surfaces (Settings → AI
 * Keys) call this through `@inariwatch/ai-router` so the raw provider URL
 * lives inside `providers/` (lockdown rule allowed).
 */
export async function validateProviderKey(
  provider: AIProvider,
  apiKey: string,
): Promise<ValidateKeyResult> {
  const adapter = CLOUD_PROVIDERS[provider];
  if (!adapter) {
    return { valid: false, error: `Unknown provider "${provider}"` };
  }
  return adapter.validateKey(apiKey);
}
