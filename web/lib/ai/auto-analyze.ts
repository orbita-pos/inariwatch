import { db, alerts, projects } from "@/lib/db";
import { eq, and, gt, ne, sql } from "drizzle-orm";
import { callAI } from "./client";
import type { AIProvider } from "./client";
import { SYSTEM_ANALYZER, buildAnalyzePrompt } from "./prompts";
import { getProjectOwnerAIKey, PLATFORM_MODEL } from "./get-key";
import { correlateProjectAlerts } from "./correlate";
import { computeErrorFingerprint } from "./fingerprint";
import { classifyAlert, type ClassificationResult, type TriageClass } from "./alert-classifier";
import { assertWithinQuota, incrementQuota, QuotaExceededError } from "./quota";
import { reservePlatformBudget, PlatformBudgetExceededError } from "./spend-guard";
import { acquireAIConcurrency, ConcurrencyLimitError } from "./concurrency-gate";
import { getRedis } from "@/lib/redis";
import { heuristicAnalyze } from "./heuristic-fallback";
import type { Alert } from "@/lib/db";

// Pessimistic estimate for one auto-analyze call (Haiku/4o-mini, 300 max
// tokens out, ~2K tokens in). Reconciled to actual after the call.
const AUTO_ANALYZE_RESERVE_CENTS = 2;

/**
 * Auto-analyze a newly created alert with AI and persist the reasoning.
 * Also triggers correlation if there are other recent alerts for the same project.
 *
 * Non-throwing, fire-and-forget — call with .catch(() => {}).
 */
export async function autoAnalyzeAlert(alert: Alert): Promise<void> {
  const aiKey = await getProjectOwnerAIKey(alert.projectId);
  if (!aiKey) return;

  // Check Redis cache — same fingerprint = same diagnosis (saves AI call + $0.005)
  const fingerprint = computeErrorFingerprint(alert.title, alert.body ?? "");
  const redis = getRedis();
  let cachedReasoning: string | null = null;
  if (redis) {
    try {
      cachedReasoning = await redis.get<string>(`ai_diag:${fingerprint}`);
    } catch {
      // Redis unavailable — proceed with AI call
    }
  }

  // Resolve project owner for cost attribution + quota.
  const [proj] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  // Check quota before making the AI call.
  if (proj) {
    try {
      await assertWithinQuota(proj.userId, "auto-analyze");
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // Skip silently — user will see "limit reached" in dashboard
        return;
      }
      throw err;
    }
  }

  // Platform-AI kill-switch: pre-reserve estimated cost. Reconciled to
  // actual in usage-logger after the call. Throws PlatformBudgetExceededError
  // when the daily cap is hit — caller catches and persists aiSkippedReason.
  let reservedCents = 0;
  if (aiKey.isPlatformKey) {
    try {
      await reservePlatformBudget(AUTO_ANALYZE_RESERVE_CENTS);
      reservedCents = AUTO_ANALYZE_RESERVE_CENTS;
    } catch (err) {
      if (err instanceof PlatformBudgetExceededError) {
        // Persist reason so the alert page can show a banner.
        await db
          .update(alerts)
          .set({ aiSkippedReason: "platform_budget" })
          .where(eq(alerts.id, alert.id));
        return;
      }
      throw err;
    }
  }

  // Concurrency gate — prevent a single user/project from saturating AI capacity.
  let releaseConcurrency: (() => void) | null = null;
  if (proj) {
    try {
      releaseConcurrency = acquireAIConcurrency(proj.userId, alert.projectId);
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) return;
      throw err;
    }
  }

  try {

  // Classify alert to determine cheapest effective path.
  // Fine-tuned model (~$0.0001) or heuristic fallback (free).
  let classification: ClassificationResult | null = null;
  try {
    classification = await classifyAlert(
      alert.title,
      alert.body ?? "",
      alert.severity,
      alert.sourceIntegrations,
      aiKey.isPlatformKey ? aiKey.key : undefined,
    );
  } catch {
    // Classifier unavailable — proceed with full analysis
  }

  // ── FrugalGPT cascade ────────────────────────────────────────────────────
  // Route to cheapest model first based on classifier. Escalate if response
  // quality is too low. Saves 50-90% on analysis costs.
  //
  // Cascade tiers (platform key path):
  //   auto_fix / triage_only → Tier 0: Groq Llama 8B ($0.05/M, ~800 tok/s)
  //   full_remediation       → Tier 1: GPT-4o-mini ($0.15/M)
  //   Escalation fallback    → Tier 1: GPT-4o-mini
  //
  // BYOK users always use their own configured model (no cascade).

  const prompt = buildAnalyzePrompt({
    title: alert.title,
    severity: alert.severity,
    body: alert.body ?? "",
    sourceIntegrations: alert.sourceIntegrations,
  });
  const messages: { role: "user"; content: string }[] = [{ role: "user", content: prompt }];
  const logCtx = proj ? {
    log: {
      userId: proj.userId,
      projectId: alert.projectId,
      alertId: alert.id,
      feature: "auto-analyze" as const,
      isPlatformKey: aiKey.isPlatformKey,
      reservedPlatformCents: reservedCents,
    },
  } : {};

  let reasoning: string;
  let cascadeInfo: { tierUsed: number; model: string; provider: string; escalated: boolean } | null = null;
  if (cachedReasoning) {
    // Cache hit — skip AI call but still record cascade info as "cached"
    reasoning = cachedReasoning;
    cascadeInfo = { tierUsed: -1, model: "redis-cache", provider: "cache", escalated: false };
    // InariLens visibility — the admin dashboard's "Cache hit rate 24h"
    // widget keys on cached=true rows, so we need to record this even
    // though no AI call was made.
    if (proj) {
      const { logAICall } = await import("./lens");
      logAICall({
        userId: proj.userId,
        projectId: alert.projectId,
        alertId: alert.id,
        feature: "auto-analyze",
        provider: "cache",
        model: "redis-cache",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        isPlatformKey: aiKey.isPlatformKey,
        cached: true,
        prompt,
        response: cachedReasoning,
      });
    }
  } else {
    try {
      const result = await cascadeAnalyze(
        aiKey.key,
        aiKey.provider,
        aiKey.isPlatformKey ?? false,
        messages,
        classification?.triageClass ?? null,
        logCtx,
      );
      reasoning = result.reasoning;
      cascadeInfo = { tierUsed: result.tierUsed, model: result.model, provider: result.provider, escalated: result.escalated };
    } catch {
      const fallback = heuristicAnalyze(alert.title, alert.body ?? "");
      reasoning = fallback?.reasoning ?? "AI analysis temporarily unavailable. Please check alert details manually.";
    }
  }

  // Build correlation metadata — atomic jsonb merge preserves any data
  // written by correlate.ts between when we read the alert and now.
  const metaUpdate: Record<string, unknown> = {};
  if (classification) {
    metaUpdate.triageClass = classification.triageClass;
    metaUpdate.triageConfidence = classification.confidence;
    metaUpdate.triageMethod = classification.method;
  }
  if (cascadeInfo) {
    metaUpdate.cascadeTier = cascadeInfo.tierUsed;
    metaUpdate.analyzeModel = cascadeInfo.model;
    metaUpdate.analyzeProvider = cascadeInfo.provider;
    metaUpdate.cascadeEscalated = cascadeInfo.escalated;
  }

  await db
    .update(alerts)
    .set({
      aiReasoning: reasoning,
      ...(Object.keys(metaUpdate).length > 0 ? {
        correlationData: sql`COALESCE(${alerts.correlationData}, '{}'::jsonb) || ${JSON.stringify(metaUpdate)}::jsonb`,
      } : {}),
    })
    .where(eq(alerts.id, alert.id));

  // Increment quota after successful call
  if (proj) {
    incrementQuota(proj.userId, "auto-analyze").catch(() => {});
  }

  // Cache diagnosis by fingerprint (1h TTL)
  if (redis && reasoning) {
    redis.set(`ai_diag:${fingerprint}`, reasoning, { ex: 3600 }).catch(() => {});
  }

  // Post AI diagnosis to Slack thread (if alert has one)
  try {
    const { sendThreadReply } = await import("@/lib/slack/send");
    sendThreadReply(alert.id, `*AI Diagnosis:*\n${reasoning}`).catch(() => {});
  } catch {
    // Non-blocking
  }

  // Correlation: look for other recent alerts from the same project (last 30 min)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const recentSiblings = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, alert.projectId),
        gt(alerts.createdAt, thirtyMinAgo),
        ne(alerts.id, alert.id)
      )
    );

  if (recentSiblings.length >= 1) {
    // Pass the full group (this alert + siblings) to the correlator
    await correlateProjectAlerts([alert, ...recentSiblings], alert.projectId);
  }

  } finally {
    releaseConcurrency?.();
  }
}

// ── Cascade implementation ─────────────────────────────────────────────────

const GROQ_KEY = process.env.GROQ_API_KEY ?? "";
const MIN_RESPONSE_LENGTH = 30;

interface CascadeTier {
  key: string;
  provider: AIProvider;
  model: string;
  maxTokens: number;
}

function buildCascadeTiers(
  userKey: string,
  userProvider: AIProvider,
  isPlatformKey: boolean,
  triageClass: TriageClass | null,
): CascadeTier[] {
  // BYOK users — no cascade, use their configured model directly
  if (!isPlatformKey) {
    return [{ key: userKey, provider: userProvider, model: PLATFORM_MODEL, maxTokens: 300 }];
  }

  // Platform key cascade: cheap → standard
  const tiers: CascadeTier[] = [];

  // Tier 0: Groq (ultra-cheap) — for auto_fix and triage_only
  if (GROQ_KEY && triageClass && triageClass !== "full_remediation") {
    tiers.push({
      key: GROQ_KEY,
      provider: "groq" as AIProvider,
      model: "llama-3.1-8b-instant",
      maxTokens: 200,
    });
  }

  // Tier 1: GPT-4o-mini (standard) — always present as fallback
  tiers.push({
    key: userKey,
    provider: "openai" as AIProvider,
    model: PLATFORM_MODEL,
    maxTokens: 300,
  });

  return tiers;
}

function isResponseAdequate(response: string): boolean {
  if (!response || response.length < MIN_RESPONSE_LENGTH) return false;
  const genericPhrases = [
    "I need more information",
    "Unable to determine",
    "I cannot analyze",
    "not enough context",
  ];
  const lower = response.toLowerCase();
  return !genericPhrases.some((p) => lower.includes(p.toLowerCase()));
}

interface CascadeResult {
  reasoning: string;
  tierUsed: number;
  model: string;
  provider: string;
  escalated: boolean;
}

async function cascadeAnalyze(
  userKey: string,
  userProvider: AIProvider,
  isPlatformKey: boolean,
  messages: { role: "user"; content: string }[],
  triageClass: TriageClass | null,
  logCtx: Record<string, unknown>,
): Promise<CascadeResult> {
  const tiers = buildCascadeTiers(userKey, userProvider, isPlatformKey, triageClass);

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const isLastTier = i === tiers.length - 1;

    try {
      const result = await callAI(
        tier.key,
        SYSTEM_ANALYZER,
        messages,
        {
          maxTokens: tier.maxTokens,
          model: tier.model,
          provider: tier.provider,
          ...logCtx,
        },
      );

      if (isLastTier || isResponseAdequate(result)) {
        return { reasoning: result, tierUsed: i, model: tier.model, provider: tier.provider, escalated: i > 0 };
      }
    } catch (err) {
      if (isLastTier) throw err;
    }
  }

  return { reasoning: "", tierUsed: -1, model: "", provider: "", escalated: false };
}
