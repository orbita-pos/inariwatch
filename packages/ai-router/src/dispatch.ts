// Public dispatch() — the only entry point surfaces use to make AI calls.
//
// Per INARI_AI_ARCHITECTURE.md §2.3 (LOCKED 2026-05-02), every AI call in the
// monorepo lands here, tags itself with a `task` name, and the router decides
// where to run it. Phase 1 (S1) routes everything to cloud — behavior is
// byte-identical to pre-refactor calls.

import {
  CLOUD_PROVIDERS,
  SIDECAR,
  openaiEmbed,
  type ProviderAdapter,
} from "./providers";
import {
  setActiveSidecarUser,
  takeLastUserSidecarReceipt,
} from "./providers/user-sidecar";
import type {
  AIMessage,
  AIResponse,
  AIVisionMessage,
  CompleteOpts,
  ContentBlock,
  TextBlock,
  ToolDefinition,
  ToolUseOpts,
  ToolUseResponse,
  VisionOpts,
} from "./providers/types";
import {
  type AIProvider,
  type FallbackTrigger,
  type Rule,
  type Substrate,
  type Target,
  type WorkspacePreferences,
  getRule,
  resolvePrimary,
} from "./rules";
import { emitReceipt } from "./receipts";
import { TASKS, type TaskName, namespaceOf } from "./tasks";

// ── Public input/output shapes ──────────────────────────────────────────────

export type DispatchMode = "complete" | "tool-use" | "vision" | "embed";

export interface WorkspaceContext {
  /** Database id of the workspace owner. Used for receipts + workspace prefs. */
  userId?: string;
  workspaceId?: string;
  projectId?: string;
  alertId?: string;
  remediationSessionId?: string;
  preferences?: WorkspacePreferences;
  /**
   * True when `apiKey` is the platform-funded key (PLATFORM_AI_KEY /
   * PLATFORM_ANTHROPIC_KEY). Logged on receipts so cost attribution is
   * trivial in `/admin/ops`.
   */
  isPlatformKey?: boolean;
}

export interface DispatchHints {
  /** Loose advisory — caller cares about latency more than depth of reasoning. */
  latencySensitive?: boolean;
}

interface DispatchBase {
  task: TaskName;
  apiKey: string;
  workspace?: WorkspaceContext;
  hints?: DispatchHints;
  /**
   * Explicit provider override — wins over rule.primary.provider AND
   * detectProvider(apiKey). Mirrors CallAIOpts.provider in the legacy client.
   */
  provider?: AIProvider;
  /**
   * Pass-through context for InariLens / ai_usage_logs telemetry. Forwarded
   * to the receipt for downstream `/admin/ops` joins.
   */
  log?: Record<string, unknown>;
}

export interface DispatchComplete extends DispatchBase {
  mode: "complete";
  systemPrompt: string;
  messages: AIMessage[];
  maxTokens?: number;
  model?: string;
  timeout?: number;
  /** Forwarded to providers that accept sampling temperature. */
  temperature?: number;
  /** Force JSON output (OpenAI-compatible only). */
  jsonMode?: boolean;
}

export interface DispatchToolUse extends DispatchBase {
  mode: "tool-use";
  systemPrompt: string;
  messages: AIMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  model?: string;
  timeout?: number;
  priorOutput?: Array<Record<string, unknown>>;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  strict?: boolean;
  toolChoice?: "auto" | "required" | { type: "function"; name: string };
  parallelToolCalls?: boolean;
}

export interface DispatchVision extends DispatchBase {
  mode: "vision";
  systemPrompt: string;
  message: AIVisionMessage;
  maxTokens?: number;
  model?: string;
  timeout?: number;
}

export interface DispatchEmbed extends DispatchBase {
  mode: "embed";
  input: string | string[];
  model?: string;
  timeout?: number;
  /** Optional output-dimension truncation (text-embedding-3-* only). */
  dimensions?: number;
}

export type DispatchInput =
  | DispatchComplete
  | DispatchToolUse
  | DispatchVision
  | DispatchEmbed;

export type DispatchOutput =
  | { mode: "complete"; response: AIResponse }
  | {
      mode: "tool-use";
      response: ToolUseResponse;
      usage: AIResponse["usage"];
      model: string;
    }
  | { mode: "vision"; text: string; usage: AIResponse["usage"]; model: string }
  | {
      mode: "embed";
      vectors: number[][];
      model: string;
      usage: { inputTokens: number };
    };

// ── Provider detection ──────────────────────────────────────────────────────

/**
 * Mirrors web/lib/ai/client.ts `detectProvider`. Kept here so the router is
 * self-contained — surfaces hand us an apiKey + (optional) hint, and we do
 * the right thing without any coupling back into web.
 */
export function detectProvider(key: string): AIProvider {
  if (key.startsWith("sk-ant-")) return "claude";
  if (key.startsWith("xai-")) return "grok";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("AIza")) return "gemini";
  return "openai";
}

function pickProvider(input: DispatchInput, target: Target): AIProvider {
  // Phase 1 is a zero-behavior-change refactor. Per rules.ts, cloud-target
  // `provider` is an advisory hint — the legacy client routed solely on
  // `opts.provider ?? detectProvider(apiKey)`. Honor that contract.
  // Order: caller-explicit > apiKey prefix > rule hint > openai default.
  if (input.provider) return input.provider;
  const detected = detectProvider(input.apiKey);
  if (detected !== "openai") return detected;
  if (target.substrate === "cloud" && target.provider) return target.provider;
  return detected;
}

// ── Substrate runners ───────────────────────────────────────────────────────

interface RunResult {
  output: DispatchOutput;
  /** Provider/model recorded for the receipt. */
  provider: AIProvider | "user-sidecar" | "capture-embedded" | "cli-linked";
  model: string;
  substrate: Substrate;
}

async function runOnTarget(
  input: DispatchInput,
  target: Target,
): Promise<RunResult> {
  if (target.substrate === "cloud") {
    return runOnCloud(input, target);
  }
  if (target.substrate === "user-sidecar") {
    return runOnSidecar(input);
  }
  // capture-embedded / cli-linked are Phase 5+ — fall through to throw.
  throw new Error(
    `substrate "${target.substrate}" not implemented in Phase 1 — coming in v0.3 S5/S7`,
  );
}

async function runOnCloud(
  input: DispatchInput,
  target: Target,
): Promise<RunResult> {
  const provider = pickProvider(input, target);
  const adapter: ProviderAdapter = CLOUD_PROVIDERS[provider];
  if (!adapter) throw new Error(`No adapter for provider "${provider}"`);

  // Cloud target's `model` hint is advisory only in Phase 1 — caller's
  // model wins. Phase 3+ rules will pin model on substrate-locked tasks.
  const out = await runAdapter(input, adapter, provider);
  // Pull model out of the result so receipts have a single source of truth.
  const model = modelFromOutput(out);
  return { output: out, provider, model, substrate: "cloud" };
}

async function runOnSidecar(input: DispatchInput): Promise<RunResult> {
  // v0.3 S2: real WS relay path. We push the workspace.userId into the
  // user-sidecar provider's static slot just before the call (cleared in
  // finally so cross-request leakage is impossible). If no userId is
  // present the provider throws `sidecar-offline`, the dispatch core
  // catches it via shouldFallback() and re-runs on cloud.
  setActiveSidecarUser(input.workspace?.userId ?? null);
  try {
    const out = await runAdapter(input, SIDECAR, "openai" /* placeholder */);
    const model = modelFromOutput(out);
    return { output: out, provider: "user-sidecar", model, substrate: "user-sidecar" };
  } finally {
    setActiveSidecarUser(null);
  }
}

async function runAdapter(
  input: DispatchInput,
  adapter: ProviderAdapter,
  fallbackProvider: AIProvider,
): Promise<DispatchOutput> {
  switch (input.mode) {
    case "complete": {
      const opts: CompleteOpts = {
        apiKey: input.apiKey,
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        maxTokens: input.maxTokens,
        model: input.model,
        timeout: input.timeout,
        temperature: input.temperature,
        jsonMode: input.jsonMode,
      };
      const response = await adapter.complete(opts);
      return { mode: "complete", response };
    }
    case "tool-use": {
      const opts: ToolUseOpts = {
        apiKey: input.apiKey,
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        tools: input.tools,
        maxTokens: input.maxTokens,
        model: input.model,
        timeout: input.timeout,
        priorOutput: input.priorOutput,
        reasoningEffort: input.reasoningEffort,
        strict: input.strict,
        toolChoice: input.toolChoice,
        parallelToolCalls: input.parallelToolCalls,
      };
      const r = await adapter.withTools(opts);
      const response: ToolUseResponse =
        r.stopReason === "end_turn"
          ? {
              stopReason: "end_turn",
              text: r.text,
              responseId: r.responseId,
              priorOutput: r.priorOutput,
            }
          : {
              stopReason: "tool_use",
              content: r.content,
              responseId: r.responseId,
              priorOutput: r.priorOutput,
            };
      return {
        mode: "tool-use",
        response,
        usage: r.usage,
        model: r.model,
      };
    }
    case "vision": {
      const opts: VisionOpts = {
        apiKey: input.apiKey,
        systemPrompt: input.systemPrompt,
        message: input.message,
        maxTokens: input.maxTokens,
        model: input.model,
        timeout: input.timeout,
      };
      const r = await adapter.vision(opts);
      return {
        mode: "vision",
        text: r.text,
        usage: r.usage,
        model: r.model,
      };
    }
    case "embed": {
      // Embeddings are OpenAI-only in Phase 1 — Code Intelligence's existing
      // embed pipeline pins on text-embedding-3-small. Other providers will
      // be added when there's a need.
      void fallbackProvider;
      const r = await openaiEmbed(
        input.apiKey,
        input.input,
        input.model,
        input.timeout,
        input.dimensions,
      );
      return {
        mode: "embed",
        vectors: r.vectors,
        model: r.model,
        usage: r.usage,
      };
    }
  }
}

function modelFromOutput(out: DispatchOutput): string {
  switch (out.mode) {
    case "complete":
      return out.response.model;
    case "tool-use":
      return out.model;
    case "vision":
      return out.model;
    case "embed":
      return out.model;
  }
}

// ── Fallback policy ─────────────────────────────────────────────────────────

function shouldFallback(
  err: unknown,
  triggers: FallbackTrigger[] | undefined,
): boolean {
  if (!triggers || triggers.length === 0) return false;
  const msg = err instanceof Error ? err.message : String(err);

  for (const trigger of triggers) {
    switch (trigger) {
      case "sidecar-offline":
      case "sidecar-timeout":
        if (
          msg.includes("user-sidecar substrate not implemented") ||
          /sidecar/i.test(msg) ||
          /timeout/i.test(msg)
        ) {
          return true;
        }
        break;
      case "cloud-rate-limit":
        if (msg.includes("(429)")) return true;
        break;
      case "cloud-error":
        if (
          msg.includes("(500)") ||
          msg.includes("(502)") ||
          msg.includes("(503)")
        ) {
          return true;
        }
        break;
      // workspace-flag-cloud-only / cloud-budget-exceeded are decided BEFORE
      // dispatch (rule resolution + spend-guard); not signaled by exceptions.
      default:
        break;
    }
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Dispatch an AI task to its routed substrate. The input is a discriminated
 * union over `mode`; each mode returns a matching shape on the output side.
 *
 * Phase 1 routes every task to cloud. Phase 3+ flips per-task rules to
 * user-sidecar / capture-embedded / cli-linked.
 */
export async function dispatch(
  input: DispatchInput,
): Promise<DispatchOutput> {
  const tStart = Date.now();
  const rule: Rule = getRule(input.task);
  const primary = resolvePrimary(input.task, input.workspace?.preferences);

  let result: RunResult;
  let usedFallback = false;
  try {
    result = await runOnTarget(input, primary);
  } catch (err) {
    if (rule.fallback && shouldFallback(err, rule.fallbackTriggers)) {
      result = await runOnTarget(input, rule.fallback);
      usedFallback = true;
    } else {
      throw err;
    }
  }

  // v0.3 S2 — when a dispatch ran on user-sidecar, the sidecar signs the
  // receipt with the user's local Ed25519 key (S27/S28 chain) and rides
  // it back via the relay response. Web persists it without re-signing.
  // For other substrates this is null; web's sink computes its own
  // cloud-key-signed receipt.
  const userSidecarReceipt =
    result.substrate === "user-sidecar" ? takeLastUserSidecarReceipt() : null;

  // Receipt emission is fire-and-forget. The sink (web's DB layer) handles
  // its own errors; the router never lets receipt failures bubble back.
  emitReceipt({
    task: input.task,
    namespace: namespaceOf(input.task),
    substrate: result.substrate,
    provider: result.provider,
    model: result.model,
    tsStart: tStart,
    tsEnd: Date.now(),
    workspaceId: input.workspace?.workspaceId,
    userId: input.workspace?.userId,
    projectId: input.workspace?.projectId,
    alertId: input.workspace?.alertId,
    remediationSessionId: input.workspace?.remediationSessionId,
    isPlatformKey: input.workspace?.isPlatformKey ?? false,
    fallbackUsed: usedFallback,
    relayPath: result.substrate === "user-sidecar" ? "relay" : "direct",
    userSidecarReceipt: userSidecarReceipt ?? undefined,
  });

  return result.output;
}

// ── Convenience helpers (parity with legacy client.ts) ──────────────────────
//
// These mirror the existing callAI / callAIWithTools / callAIVision shape so
// the refactor in web/lib/ai/* is mechanical. Surfaces that don't yet have a
// well-typed task can pick a generic one, but the lockdown rule in S2 should
// make this rare.

export interface CallOpts {
  task?: TaskName;
  maxTokens?: number;
  model?: string;
  timeout?: number;
  provider?: AIProvider;
  workspace?: WorkspaceContext;
  hints?: DispatchHints;
  log?: Record<string, unknown>;
  temperature?: number;
  jsonMode?: boolean;
}

const DEFAULT_TASK: TaskName = TASKS.ALERT_AUTO_ANALYZE;

export async function callAI(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallOpts = {},
): Promise<string> {
  const out = await dispatch({
    mode: "complete",
    task: opts.task ?? DEFAULT_TASK,
    apiKey,
    systemPrompt,
    messages,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
    model: opts.model,
    timeout: opts.timeout,
    workspace: opts.workspace,
    hints: opts.hints,
    log: opts.log,
    temperature: opts.temperature,
    jsonMode: opts.jsonMode,
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  return out.response.text;
}

export async function callAIWithUsage(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  opts: CallOpts = {},
): Promise<AIResponse> {
  const out = await dispatch({
    mode: "complete",
    task: opts.task ?? DEFAULT_TASK,
    apiKey,
    systemPrompt,
    messages,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
    model: opts.model,
    timeout: opts.timeout,
    workspace: opts.workspace,
    hints: opts.hints,
    log: opts.log,
    temperature: opts.temperature,
    jsonMode: opts.jsonMode,
  });
  if (out.mode !== "complete") {
    throw new Error("Internal: dispatch returned non-complete shape");
  }
  return out.response;
}

export async function callAIWithTools(
  apiKey: string,
  systemPrompt: string,
  messages: AIMessage[],
  tools: ToolDefinition[],
  opts: CallOpts & {
    priorOutput?: Array<Record<string, unknown>>;
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    strict?: boolean;
    toolChoice?: "auto" | "required" | { type: "function"; name: string };
    parallelToolCalls?: boolean;
  } = {},
): Promise<ToolUseResponse> {
  const out = await dispatch({
    mode: "tool-use",
    task: opts.task ?? TASKS.CODE_FIX_AGENT_LOOP,
    apiKey,
    systemPrompt,
    messages,
    tools,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
    model: opts.model,
    timeout: opts.timeout,
    priorOutput: opts.priorOutput,
    reasoningEffort: opts.reasoningEffort,
    strict: opts.strict,
    toolChoice: opts.toolChoice,
    parallelToolCalls: opts.parallelToolCalls,
    workspace: opts.workspace,
    hints: opts.hints,
    log: opts.log,
  });
  if (out.mode !== "tool-use") {
    throw new Error("Internal: dispatch returned non-tool-use shape");
  }
  return out.response;
}

export async function callAIVision(
  apiKey: string,
  systemPrompt: string,
  message: AIVisionMessage,
  opts: CallOpts = {},
): Promise<string> {
  // Groq + DeepSeek don't support vision — mirror legacy fallback to text-only.
  const provider = opts.provider ?? detectProvider(apiKey);
  if (provider === "groq" || provider === "deepseek") {
    return callAI(
      apiKey,
      systemPrompt,
      [
        {
          role: "user",
          content: `${message.text}\n\n(Screenshot was captured but your AI provider does not support vision. Analysis is text-only.)`,
        },
      ],
      opts,
    );
  }
  const out = await dispatch({
    mode: "vision",
    task: opts.task ?? DEFAULT_TASK,
    apiKey,
    systemPrompt,
    message,
    provider: opts.provider,
    maxTokens: opts.maxTokens,
    model: opts.model,
    timeout: opts.timeout,
    workspace: opts.workspace,
    hints: opts.hints,
    log: opts.log,
  });
  if (out.mode !== "vision") {
    throw new Error("Internal: dispatch returned non-vision shape");
  }
  return out.text;
}

export async function callAIEmbed(
  apiKey: string,
  input: string | string[],
  opts: {
    task?: TaskName;
    model?: string;
    timeout?: number;
    dimensions?: number;
    workspace?: WorkspaceContext;
  } = {},
): Promise<{ vectors: number[][]; model: string; usage: { inputTokens: number } }> {
  const out = await dispatch({
    mode: "embed",
    task: opts.task ?? TASKS.CODE_EMBED,
    apiKey,
    input,
    model: opts.model,
    timeout: opts.timeout,
    dimensions: opts.dimensions,
    workspace: opts.workspace,
  });
  if (out.mode !== "embed") {
    throw new Error("Internal: dispatch returned non-embed shape");
  }
  return { vectors: out.vectors, model: out.model, usage: out.usage };
}

// Re-exports for surface code that still needs the helpers
export {
  buildResponsesInput as buildOpenAIResponsesInput,
} from "./providers/openai";
export {
  buildToolsWithCache,
  buildMessagesWithCache,
} from "./providers/anthropic";
export type {
  AIMessage,
  AIVisionMessage,
  AIResponse,
  ContentBlock,
  TextBlock,
  ToolDefinition,
  ToolUseResponse,
};
