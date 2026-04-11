/**
 * AI Quota enforcement.
 *
 * Each user has a monthly allocation per feature based on their plan.
 * This module tracks usage and blocks calls when limits are exceeded.
 *
 * Free plan:
 *   - 300 auto-analyses
 *   - 3 AI remediations
 *   - 100 chat messages
 *   - 10 PR predictions
 *   - 5 postmortems
 *
 * Pro plan ($12/mo):
 *   - 3,000 auto-analyses (10x)
 *   - 25 remediations (8x)
 *   - 500 chat messages (5x)
 *   - 30 PR predictions (3x)
 *   - 50 postmortems (10x)
 */

import { db, users, monthlyQuotaUsage } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";

export type QuotaFeature =
  | "auto-analyze"
  | "remediation"
  | "chat"
  | "pr-prediction"
  | "postmortem";

export type Plan = "free" | "pro";

// ── Quota limits per plan ──────────────────────────────────────────────────

export const QUOTA_LIMITS: Record<Plan, Record<QuotaFeature, number>> = {
  free: {
    "auto-analyze": 300,
    "remediation":  3,
    "chat":         100,
    "pr-prediction": 10,
    "postmortem":   5,
  },
  pro: {
    "auto-analyze": 3000,
    "remediation":  25,
    "chat":         500,
    "pr-prediction": 30,
    "postmortem":   50,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Get the start of the current month at 00:00 UTC */
export function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Map a feature to its column name in monthly_quota_usage */
const FEATURE_COLUMNS: Record<QuotaFeature, keyof typeof monthlyQuotaUsage._.columns> = {
  "auto-analyze":  "autoAnalyzeUsed",
  "remediation":   "remediationUsed",
  "chat":          "chatUsed",
  "pr-prediction": "prPredictionUsed",
  "postmortem":    "postmortemUsed",
};

const FEATURE_DB_COLUMNS: Record<QuotaFeature, string> = {
  "auto-analyze":  "auto_analyze_used",
  "remediation":   "remediation_used",
  "chat":          "chat_used",
  "pr-prediction": "pr_prediction_used",
  "postmortem":    "postmortem_used",
};

// ── Public API ─────────────────────────────────────────────────────────────

export interface UserPlan {
  plan: Plan;
  /** True if their Pro subscription is currently active. */
  isProActive: boolean;
}

/**
 * Get the user's current plan + Pro subscription status.
 */
export async function getUserPlan(userId: string): Promise<UserPlan> {
  const [row] = await db
    .select({
      plan: users.plan,
      subscriptionStatus: users.subscriptionStatus,
      subscriptionPeriodEnd: users.subscriptionPeriodEnd,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    return { plan: "free", isProActive: false };
  }

  // A user is "Pro active" only if:
  //   - users.plan = 'pro'
  //   - subscription_status is one of the valid active states
  //   - subscription_period_end is in the future (OR null for legacy)
  const validStatuses = new Set(["active", "trialing"]);
  const statusOK = row.subscriptionStatus
    ? validStatuses.has(row.subscriptionStatus)
    : true; // null = legacy/grandfathered, allow
  const periodOK = row.subscriptionPeriodEnd
    ? row.subscriptionPeriodEnd.getTime() > Date.now()
    : true;

  const isProActive = row.plan === "pro" && statusOK && periodOK;

  return {
    plan: isProActive ? "pro" : "free",
    isProActive,
  };
}

export interface QuotaStatus {
  feature: QuotaFeature;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  exceeded: boolean;
}

/**
 * Get current usage for a single feature for the user this month.
 */
export async function getQuotaStatus(
  userId: string,
  feature: QuotaFeature
): Promise<QuotaStatus> {
  const { plan } = await getUserPlan(userId);
  const limit = QUOTA_LIMITS[plan][feature];

  const periodStart = currentPeriodStart();
  const dbColumn = FEATURE_DB_COLUMNS[feature];

  const result = await db.execute<{ used: number }>(sql`
    SELECT COALESCE(${sql.raw(dbColumn)}, 0)::int AS used
    FROM monthly_quota_usage
    WHERE user_id = ${userId}
      AND period_start = ${periodStart.toISOString()}
    LIMIT 1
  `);

  const used = result.rows[0]?.used ?? 0;
  const remaining = Math.max(0, limit - used);
  const percentUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;

  return {
    feature,
    used,
    limit,
    remaining,
    percentUsed,
    exceeded: used >= limit,
  };
}

/**
 * Get usage for all features at once (for the dashboard).
 */
export async function getAllQuotaStatus(userId: string): Promise<QuotaStatus[]> {
  const { plan } = await getUserPlan(userId);
  const periodStart = currentPeriodStart();

  const result = await db.execute<{
    auto_analyze_used: number;
    remediation_used: number;
    chat_used: number;
    pr_prediction_used: number;
    postmortem_used: number;
  }>(sql`
    SELECT
      COALESCE(auto_analyze_used, 0)::int AS auto_analyze_used,
      COALESCE(remediation_used, 0)::int AS remediation_used,
      COALESCE(chat_used, 0)::int AS chat_used,
      COALESCE(pr_prediction_used, 0)::int AS pr_prediction_used,
      COALESCE(postmortem_used, 0)::int AS postmortem_used
    FROM monthly_quota_usage
    WHERE user_id = ${userId}
      AND period_start = ${periodStart.toISOString()}
    LIMIT 1
  `);

  const row = result.rows[0] ?? {
    auto_analyze_used: 0,
    remediation_used: 0,
    chat_used: 0,
    pr_prediction_used: 0,
    postmortem_used: 0,
  };

  const features: QuotaFeature[] = [
    "auto-analyze",
    "remediation",
    "chat",
    "pr-prediction",
    "postmortem",
  ];

  const usageByFeature: Record<QuotaFeature, number> = {
    "auto-analyze":  row.auto_analyze_used,
    "remediation":   row.remediation_used,
    "chat":          row.chat_used,
    "pr-prediction": row.pr_prediction_used,
    "postmortem":    row.postmortem_used,
  };

  return features.map((feature) => {
    const used = usageByFeature[feature];
    const limit = QUOTA_LIMITS[plan][feature];
    const remaining = Math.max(0, limit - used);
    const percentUsed = limit > 0 ? Math.round((used / limit) * 100) : 0;
    return {
      feature,
      used,
      limit,
      remaining,
      percentUsed,
      exceeded: used >= limit,
    };
  });
}

/**
 * Increment the usage counter for a feature. Atomic upsert.
 *
 * Call this AFTER a successful AI call. Failed calls should NOT count.
 */
export async function incrementQuota(
  userId: string,
  feature: QuotaFeature
): Promise<void> {
  const periodStart = currentPeriodStart();
  const dbColumn = FEATURE_DB_COLUMNS[feature];

  // Atomic upsert: create row if missing, increment counter if present.
  await db.execute(sql`
    INSERT INTO monthly_quota_usage (user_id, period_start, ${sql.raw(dbColumn)}, updated_at)
    VALUES (${userId}, ${periodStart.toISOString()}, 1, now())
    ON CONFLICT (user_id, period_start) DO UPDATE
      SET ${sql.raw(dbColumn)} = monthly_quota_usage.${sql.raw(dbColumn)} + 1,
          updated_at = now()
  `);
}

/**
 * Quota violation error — throw this from features when limit is exceeded.
 * Callers can catch and respond with a "limit reached" UI.
 */
export class QuotaExceededError extends Error {
  constructor(
    public feature: QuotaFeature,
    public used: number,
    public limit: number,
    public plan: Plan
  ) {
    super(
      `${feature} quota exceeded: ${used}/${limit} on ${plan} plan. ` +
        (plan === "free" ? "Upgrade to Pro for more." : "Contact support.")
    );
    this.name = "QuotaExceededError";
  }
}

/**
 * Check if the user has quota remaining for a feature.
 * Throws QuotaExceededError if exceeded.
 *
 * Call this BEFORE making the AI call. The actual increment happens
 * via incrementQuota() AFTER the call succeeds.
 */
export async function assertWithinQuota(
  userId: string,
  feature: QuotaFeature
): Promise<QuotaStatus> {
  const status = await getQuotaStatus(userId, feature);
  if (status.exceeded) {
    const { plan } = await getUserPlan(userId);
    throw new QuotaExceededError(feature, status.used, status.limit, plan);
  }
  return status;
}

/**
 * Check + increment in one call. Use this for fire-and-forget code paths
 * where you don't need granular error handling.
 *
 * Returns true if allowed, false if quota exceeded.
 */
export async function checkAndIncrement(
  userId: string,
  feature: QuotaFeature
): Promise<boolean> {
  try {
    await assertWithinQuota(userId, feature);
    await incrementQuota(userId, feature);
    return true;
  } catch (err) {
    if (err instanceof QuotaExceededError) return false;
    throw err;
  }
}

/**
 * Reset all quotas for the new month. Called by the cron on day 1.
 *
 * We don't actually delete old rows — we just rely on `period_start` to
 * scope queries to the current month. Old rows are kept for audit/history.
 */
export async function resetMonthlyQuotas(): Promise<void> {
  const periodStart = currentPeriodStart();

  // Pre-create empty rows for all users for the new period.
  // This is optional — incrementQuota will create them lazily anyway —
  // but doing it here ensures the dashboard shows 0/limit on day 1
  // before the user makes their first call.
  await db.execute(sql`
    INSERT INTO monthly_quota_usage (user_id, period_start, updated_at)
    SELECT id, ${periodStart.toISOString()}, now()
    FROM users
    ON CONFLICT (user_id, period_start) DO NOTHING
  `);
}
