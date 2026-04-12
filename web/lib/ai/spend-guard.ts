/**
 * Platform AI spend kill-switch.
 *
 * Caps the total daily cost of ALL platform-funded AI calls (auto-analyze,
 * chat, remediation, postmortem, risk assessment, correlation, prediction).
 * Once the cap is hit, platform-funded calls throw PlatformBudgetExceededError
 * until midnight UTC. Users with their own BYOK key are unaffected.
 *
 * Pattern: pre-reservation. Callers reserve an estimated cost before
 * making the AI call. After the call, usage-logger.ts reconciles by
 * adding (actual - estimate). This eliminates the race window where N
 * parallel calls all pass a read-only check before any has incremented.
 *
 * Tunable via PLATFORM_AI_DAILY_CAP_CENTS env var (default 10000 = $100/day).
 *
 * Failure modes:
 *   - Redis unavailable → fail OPEN (per-user quotas in quota.ts still
 *     enforce; this is just an additional safety net)
 *   - Cap exceeded → throws PlatformBudgetExceededError, caller decides
 *     how to degrade gracefully (auto-analyze sets aiSkippedReason on
 *     the alert and lets the user know in the UI)
 */

import { incrDailyCounterCents, getDailyCounterCents } from "@/lib/redis";

const COUNTER_KEY = "platform_ai_spend_cents";
const DEFAULT_CAP_CENTS = 10000; // $100/day

function getCapCents(): number {
  const env = process.env.PLATFORM_AI_DAILY_CAP_CENTS;
  if (!env) return DEFAULT_CAP_CENTS;
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_CENTS;
}

export class PlatformBudgetExceededError extends Error {
  constructor(
    public usedCents: number,
    public capCents: number
  ) {
    super(
      `Platform AI daily budget exhausted: ${usedCents}¢ / ${capCents}¢. ` +
        "Free AI features will resume at midnight UTC."
    );
    this.name = "PlatformBudgetExceededError";
  }
}

/**
 * Atomically reserve `estCents` against today's platform AI budget.
 * Throws PlatformBudgetExceededError if the cap would be exceeded.
 *
 * Call this BEFORE any AI call that uses the platform key. The caller
 * MUST then pass the same `estCents` value as `reservedPlatformCents` to
 * logAiUsage so the reconciliation step can add the delta between the
 * estimate and the actual cost.
 *
 * If the reservation lands above the cap, this rolls back the increment
 * and throws — so the counter doesn't keep climbing as more requests
 * bounce off the cap.
 */
export async function reservePlatformBudget(estCents: number): Promise<void> {
  if (estCents <= 0) return;
  const cap = getCapCents();
  const newVal = await incrDailyCounterCents(COUNTER_KEY, estCents);
  if (newVal == null) {
    // Redis down — fail open. Per-user quotas still enforce.
    console.warn("[spend-guard] Redis unavailable, allowing platform AI call");
    return;
  }
  if (newVal > cap) {
    // Over cap — roll back our reservation so the counter doesn't drift up
    await incrDailyCounterCents(COUNTER_KEY, -estCents);
    throw new PlatformBudgetExceededError(newVal, cap);
  }
}

/**
 * Reconcile the actual cost of a completed AI call against a previous
 * reservation. Adds (actual - estimate) to the counter.
 *
 * Called from usage-logger.ts after a successful call. If the caller
 * didn't pre-reserve (estCents=0), this just adds the full actual cost
 * — useful for paths where reservation is impractical.
 *
 * Never throws — counter drift is preferable to a broken AI feature.
 */
export async function reconcilePlatformSpend(
  estCents: number,
  actualCents: number
): Promise<void> {
  const delta = actualCents - estCents;
  if (delta === 0) return;
  try {
    await incrDailyCounterCents(COUNTER_KEY, delta);
  } catch (err) {
    console.error("[spend-guard] reconcile failed:", err);
  }
}

/**
 * Read the current daily spend + cap for monitoring / UI / cron alerts.
 * Never throws — returns zeros on Redis failure.
 */
export async function getPlatformBudgetStatus(): Promise<{
  usedCents: number;
  capCents: number;
  percentUsed: number;
}> {
  const usedCents = await getDailyCounterCents(COUNTER_KEY);
  const capCents = getCapCents();
  return {
    usedCents,
    capCents,
    percentUsed: capCents > 0 ? Math.round((usedCents / capCents) * 100) : 0,
  };
}
