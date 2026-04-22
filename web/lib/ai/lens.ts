/**
 * InariLens — internal AI observability (canonical, single source of truth).
 *
 * Logger for every AI call we make. All prompts, responses, tokens, costs,
 * and errors live in our own Postgres — never shipped to third-party
 * observability services. This enforces the privacy policy at the code
 * level: "logs are stored exclusively within our own infrastructure."
 *
 * Fire-and-forget: never awaits the DB, never throws. AI pipelines must
 * never break because telemetry is slow.
 */

import { db, aiUsageLogs } from "@/lib/db";
import { computeCost } from "./pricing";
import { reconcilePlatformSpend } from "./spend-guard";
import { scrub } from "./pii-scrub";

/**
 * Canonical feature names for every AI call we log. Shared between the logger
 * (this file) and the client dispatcher (client.ts) so adding a new feature
 * requires one edit here — TypeScript will then flag every call site that
 * needs an update, and the exhaustive `Record<LensFeature, ...>` below
 * forces us to set storage limits for it.
 */
export type LensFeature =
  | "auto-analyze"
  | "remediation"
  | "chat"
  | "security-scan"
  | "risk-assessment"
  | "postmortem"
  | "correlate"
  | "context-gather"
  | "self-review"
  | "replay"
  | "other";

// Per-feature storage limits. Simple features (auto-analyze, correlate) are
// kept tight to save storage; remediation needs full prompts because truncated
// rows break debugging, break the replay feature, and are unusable as
// training data for the future fine-tune (Phase 4 of the AI optimization plan).
const FEATURE_LIMITS: Record<LensFeature, { prompt: number; response: number }> = {
  "auto-analyze":    { prompt:  10_000, response:  5_000 },
  "correlate":       { prompt:  20_000, response: 10_000 },
  "risk-assessment": { prompt:  20_000, response: 10_000 },
  "postmortem":      { prompt:  20_000, response: 10_000 },
  "self-review":     { prompt: 100_000, response: 20_000 },
  "security-scan":   { prompt: 100_000, response: 20_000 },
  "remediation":     { prompt: 500_000, response: 80_000 },
  "chat":            { prompt:  20_000, response: 10_000 },
  "context-gather":  { prompt:  10_000, response:  5_000 },
  "replay":          { prompt: 500_000, response: 80_000 },
  "other":           { prompt:  50_000, response: 50_000 },
};

/**
 * Fase 1 telemetry — per-turn/per-tool fields populated by the tier router,
 * container agent, and CodeAct sandbox in Fases 3/5/6. Every field is optional
 * so existing callers continue to insert without emitting nulls explicitly.
 */
export interface LensTelemetry {
  /** Zero-based agent turn index within a remediation session. */
  turnNumber?: number | null;
  /** Time to first token in ms (streaming providers only). */
  ttftMs?: number | null;
  /** 'classify' | 'explore' | 'fix' | 'review' | 'graders' | 'other'. */
  phase?: LensPhase | null;
  /** Provider-agnostic size bucket: 'nano' | 'mini' | 'standard' | 'reasoning'. */
  modelTier?: LensModelTier | null;
  /** When the row wraps a single tool invocation, the tool name. */
  toolName?: string | null;
  /** Wall time of the tool execution on the cloud side. */
  toolExecMs?: number | null;
  /** Reasoning-token count reported by the provider. */
  reasoningTokens?: number | null;
}

export type LensPhase =
  | "classify"
  | "explore"
  | "fix"
  | "review"
  | "graders"
  | "other";

export type LensModelTier = "nano" | "mini" | "standard" | "reasoning";

export interface LensLogParams extends LensTelemetry {
  userId: string;
  projectId?: string | null;
  alertId?: string | null;
  remediationSessionId?: string | null;
  feature: LensFeature;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  durationMs?: number | null;
  isPlatformKey?: boolean;
  /** Cents pre-reserved on the platform budget kill-switch (see spend-guard). */
  reservedPlatformCents?: number;
  cached?: boolean;
  prompt?: string;
  response?: string;
  error?: string | null;
  replayOfRequestId?: string | null;
}

/**
 * Fire-and-forget insert of a single AI call row. Scrubs + truncates prompt
 * and response before storage. Reconciles the platform spend kill-switch
 * counter when the call used the platform key.
 *
 * Never throws. If the DB insert fails, we log to stderr and move on — a
 * failed telemetry insert must never surface to the AI feature that called us.
 */
export function logAICall(params: LensLogParams): void {
  void runLog(params).catch((err) => {
    console.warn("[lens] insert failed:", err instanceof Error ? err.message : err);
  });
}

async function runLog(params: LensLogParams): Promise<void> {
  const cost = computeCost(
    params.model,
    params.inputTokens,
    params.outputTokens,
    params.cachedInputTokens ?? 0
  );

  const limits = FEATURE_LIMITS[params.feature];

  await db.insert(aiUsageLogs).values({
    userId: params.userId,
    projectId: params.projectId ?? null,
    alertId: params.alertId ?? null,
    remediationSessionId: params.remediationSessionId ?? null,
    feature: params.feature,
    provider: params.provider,
    model: params.model,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    cachedInputTokens: params.cachedInputTokens ?? 0,
    costUsd: cost.toFixed(8),
    isPlatformKey: params.isPlatformKey ?? false,
    error: params.error ?? null,
    durationMs: params.durationMs ?? null,
    cached: params.cached ?? false,
    prompt: scrub(params.prompt, { maxChars: limits.prompt }),
    response: scrub(params.response, { maxChars: limits.response }),
    replayOfRequestId: params.replayOfRequestId ?? null,
    turnNumber: params.turnNumber ?? null,
    ttftMs: params.ttftMs ?? null,
    phase: params.phase ?? null,
    modelTier: params.modelTier ?? null,
    toolName: params.toolName ?? null,
    toolExecMs: params.toolExecMs ?? null,
    reasoningTokens: params.reasoningTokens ?? null,
  });

  // Reconcile platform spend kill-switch counter. Only when the call
  // actually used the platform key — BYOK calls don't touch the counter.
  //
  // Three cases:
  //   - Success with reservation: delta = (actual - reserved), can be ±
  //   - Error with reservation:   delta = (0 - reserved), refunds
  //   - Success without reserve:  delta = actual, charges full
  if (params.isPlatformKey) {
    const actualCents = cost > 0 ? Math.ceil(cost * 100) : 0;
    const estCents = params.reservedPlatformCents ?? 0;
    if (actualCents > 0 || estCents > 0) {
      await reconcilePlatformSpend(estCents, actualCents);
    }
  }
}

/**
 * Build the canonical prompt string from a system prompt + message list.
 * Format mirrors the Anthropic-style split so the replay parser can walk it
 * back out: `[SYSTEM]\n...\n---\n[USER]\n...\n---\n[ASSISTANT]\n...`.
 *
 * The parser tolerates extra `\n---\n` inside user content because it keys
 * on the `[ROLE]\n` prefix at the start of each part, so collisions with
 * markdown horizontal rules are not a correctness issue.
 */
export function serializePrompt(
  systemPrompt: string,
  messages: { role: "user" | "assistant"; content: string | unknown }[]
): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`[SYSTEM]\n${systemPrompt}`);
  for (const m of messages) {
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    parts.push(`[${m.role.toUpperCase()}]\n${content}`);
  }
  return parts.join("\n---\n");
}
