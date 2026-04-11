import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, aiUsageLogs, alerts, remediationSessions } from "@/lib/db";
import { and, eq, gte, desc, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatCost } from "@/lib/ai/pricing";
import { getAllQuotaStatus, getUserPlan, type QuotaFeature, type QuotaStatus } from "@/lib/ai/quota";
import { DollarSign, TrendingDown, TrendingUp, Activity, Zap, Brain, Calendar, Sparkles, AlertCircle } from "lucide-react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Usage — InariWatch",
  description: "Your AI BYOK spending breakdown by feature, model, and time.",
};

export const dynamic = "force-dynamic";

// ── Helpers ──────────────────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return startOfDay(d);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const FEATURE_LABELS: Record<string, string> = {
  "auto-analyze":    "Auto-analyze",
  "remediation":     "Remediation",
  "chat":            "Ask Inari",
  "security-scan":   "Security scan",
  "risk-assessment": "Risk assessment",
  "postmortem":      "Postmortem",
  "correlate":       "Correlation",
  "context-gather":  "Context gathering",
  "self-review":     "Self-review",
  "other":           "Other",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai:   "OpenAI",
  claude:   "Anthropic (Claude)",
  gemini:   "Google Gemini",
  grok:     "xAI Grok",
  deepseek: "DeepSeek",
  groq:     "Groq",
};

// ── Data fetching ────────────────────────────────────────────────────────────

async function getUsageData(userId: string) {
  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const lastMonthStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const thirtyDaysAgo = daysAgo(30);

  const [
    thisMonthTotal,
    lastMonthTotal,
    byFeature,
    byModel,
    byProvider,
    dailyBreakdown,
    topAlerts,
    topSessions,
    budgetRow,
  ] = await Promise.all([
    // This month totals
    db.execute<{
      total_calls: number;
      total_cost: string;
      total_input: number;
      total_output: number;
      total_cached: number;
    }>(sql`
      SELECT
        COUNT(*)::int AS total_calls,
        COALESCE(SUM(cost_usd), 0)::text AS total_cost,
        COALESCE(SUM(input_tokens), 0)::int AS total_input,
        COALESCE(SUM(output_tokens), 0)::int AS total_output,
        COALESCE(SUM(cached_input_tokens), 0)::int AS total_cached
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${thisMonthStart.toISOString()}
        AND is_platform_key = false
    `),

    // Last month totals (for MoM comparison)
    db.execute<{ total_cost: string; total_calls: number }>(sql`
      SELECT
        COUNT(*)::int AS total_calls,
        COALESCE(SUM(cost_usd), 0)::text AS total_cost
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${lastMonthStart.toISOString()}
        AND created_at < ${thisMonthStart.toISOString()}
        AND is_platform_key = false
    `),

    // Breakdown by feature (this month)
    db.execute<{
      feature: string;
      calls: number;
      cost: string;
      input_tokens: number;
      output_tokens: number;
    }>(sql`
      SELECT
        feature,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd), 0)::text AS cost,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${thisMonthStart.toISOString()}
        AND is_platform_key = false
      GROUP BY feature
      ORDER BY SUM(cost_usd) DESC
    `),

    // Breakdown by model
    db.execute<{
      provider: string;
      model: string;
      calls: number;
      cost: string;
      input_tokens: number;
      output_tokens: number;
    }>(sql`
      SELECT
        provider,
        model,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd), 0)::text AS cost,
        COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::int AS output_tokens
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${thisMonthStart.toISOString()}
        AND is_platform_key = false
      GROUP BY provider, model
      ORDER BY SUM(cost_usd) DESC
    `),

    // Breakdown by provider
    db.execute<{
      provider: string;
      calls: number;
      cost: string;
    }>(sql`
      SELECT
        provider,
        COUNT(*)::int AS calls,
        COALESCE(SUM(cost_usd), 0)::text AS cost
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${thisMonthStart.toISOString()}
        AND is_platform_key = false
      GROUP BY provider
      ORDER BY SUM(cost_usd) DESC
    `),

    // Daily breakdown (last 30 days)
    db.execute<{ day: string; cost: string; calls: number }>(sql`
      SELECT
        date_trunc('day', created_at)::date::text AS day,
        COALESCE(SUM(cost_usd), 0)::text AS cost,
        COUNT(*)::int AS calls
      FROM ai_usage_logs
      WHERE user_id = ${userId}
        AND created_at >= ${thirtyDaysAgo.toISOString()}
        AND is_platform_key = false
      GROUP BY day
      ORDER BY day
    `),

    // Top 10 most expensive alerts (this month)
    db.execute<{
      alert_id: string;
      title: string;
      total_cost: string;
      calls: number;
    }>(sql`
      SELECT
        u.alert_id,
        a.title,
        COALESCE(SUM(u.cost_usd), 0)::text AS total_cost,
        COUNT(*)::int AS calls
      FROM ai_usage_logs u
      JOIN alerts a ON a.id = u.alert_id
      WHERE u.user_id = ${userId}
        AND u.alert_id IS NOT NULL
        AND u.created_at >= ${thisMonthStart.toISOString()}
        AND u.is_platform_key = false
      GROUP BY u.alert_id, a.title
      ORDER BY SUM(u.cost_usd) DESC
      LIMIT 10
    `),

    // Top 10 most expensive remediation sessions
    db.execute<{
      session_id: string;
      alert_id: string;
      alert_title: string;
      total_cost: string;
      calls: number;
    }>(sql`
      SELECT
        u.remediation_session_id AS session_id,
        rs.alert_id,
        a.title AS alert_title,
        COALESCE(SUM(u.cost_usd), 0)::text AS total_cost,
        COUNT(*)::int AS calls
      FROM ai_usage_logs u
      JOIN remediation_sessions rs ON rs.id = u.remediation_session_id
      JOIN alerts a ON a.id = rs.alert_id
      WHERE u.user_id = ${userId}
        AND u.remediation_session_id IS NOT NULL
        AND u.created_at >= ${thisMonthStart.toISOString()}
        AND u.is_platform_key = false
      GROUP BY u.remediation_session_id, rs.alert_id, a.title
      ORDER BY SUM(u.cost_usd) DESC
      LIMIT 10
    `),

    // User's budget (if set)
    db.execute<{ ai_budget_monthly_usd: string | null }>(sql`
      SELECT ai_budget_monthly_usd
      FROM users
      WHERE id = ${userId}
    `),
  ]);

  const thisMonth = thisMonthTotal.rows[0];
  const lastMonth = lastMonthTotal.rows[0];
  const budget = budgetRow.rows[0]?.ai_budget_monthly_usd
    ? parseFloat(budgetRow.rows[0].ai_budget_monthly_usd)
    : null;

  return {
    thisMonth: {
      cost: parseFloat(thisMonth?.total_cost ?? "0"),
      calls: thisMonth?.total_calls ?? 0,
      inputTokens: thisMonth?.total_input ?? 0,
      outputTokens: thisMonth?.total_output ?? 0,
      cachedTokens: thisMonth?.total_cached ?? 0,
    },
    lastMonth: {
      cost: parseFloat(lastMonth?.total_cost ?? "0"),
      calls: lastMonth?.total_calls ?? 0,
    },
    byFeature: byFeature.rows.map((r) => ({
      feature: r.feature,
      calls: r.calls,
      cost: parseFloat(r.cost),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
    byModel: byModel.rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      calls: r.calls,
      cost: parseFloat(r.cost),
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
    byProvider: byProvider.rows.map((r) => ({
      provider: r.provider,
      calls: r.calls,
      cost: parseFloat(r.cost),
    })),
    daily: dailyBreakdown.rows.map((r) => ({
      day: r.day,
      cost: parseFloat(r.cost),
      calls: r.calls,
    })),
    topAlerts: topAlerts.rows.map((r) => ({
      alertId: r.alert_id,
      title: r.title,
      cost: parseFloat(r.total_cost),
      calls: r.calls,
    })),
    topSessions: topSessions.rows.map((r) => ({
      sessionId: r.session_id,
      alertId: r.alert_id,
      alertTitle: r.alert_title,
      cost: parseFloat(r.total_cost),
      calls: r.calls,
    })),
    budget,
  };
}

// ── UI components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtitle,
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  subtitle?: string;
  icon: React.ElementType;
  trend?: { direction: "up" | "down" | "flat"; text: string };
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-dim px-5 py-4">
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500 font-medium">{label}</span>
        <Icon className="h-4 w-4 text-zinc-600" />
      </div>
      <div className="text-2xl font-semibold text-fg-strong">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-zinc-500">{subtitle}</div>}
      {trend && (
        <div className={`mt-2 flex items-center gap-1 text-xs ${
          trend.direction === "up" ? "text-red-400" :
          trend.direction === "down" ? "text-emerald-400" :
          "text-zinc-500"
        }`}>
          {trend.direction === "up" && <TrendingUp className="h-3 w-3" />}
          {trend.direction === "down" && <TrendingDown className="h-3 w-3" />}
          <span>{trend.text}</span>
        </div>
      )}
    </div>
  );
}

function BarRow({
  label,
  cost,
  percentage,
  calls,
  sub,
}: {
  label: string;
  cost: number;
  percentage: number;
  calls: number;
  sub?: string;
}) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between mb-1 text-sm">
        <div className="flex-1 min-w-0">
          <span className="text-fg-base font-medium truncate">{label}</span>
          {sub && <span className="ml-2 text-xs text-zinc-500">{sub}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums">
          <span className="text-zinc-500">{calls} {calls === 1 ? "call" : "calls"}</span>
          <span className="text-fg-strong font-semibold">{formatCost(cost)}</span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-surface-inner overflow-hidden">
        <div
          className="h-full bg-inari-accent transition-all"
          style={{ width: `${Math.max(2, percentage)}%` }}
        />
      </div>
    </div>
  );
}

function DailyChart({ data }: { data: { day: string; cost: number }[] }) {
  if (data.length === 0) {
    return (
      <div className="h-32 flex items-center justify-center text-sm text-zinc-500">
        No usage yet this period
      </div>
    );
  }
  const maxCost = Math.max(...data.map((d) => d.cost), 0.0001);
  return (
    <div className="flex items-end gap-1 h-32 px-1">
      {data.map((d) => (
        <div
          key={d.day}
          className="flex-1 bg-inari-accent/80 hover:bg-inari-accent rounded-t transition-colors group relative min-w-[4px]"
          style={{ height: `${Math.max(2, (d.cost / maxCost) * 100)}%` }}
          title={`${d.day}: ${formatCost(d.cost)}`}
        >
          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap rounded bg-surface-strong px-2 py-1 text-[10px] text-fg-strong opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            {d.day}<br />{formatCost(d.cost)}
          </span>
        </div>
      ))}
    </div>
  );
}

const QUOTA_LABELS: Record<QuotaFeature, string> = {
  "auto-analyze": "Auto-analyses",
  "remediation": "AI Remediations",
  "chat": "Ask Inari",
  "pr-prediction": "PR Predictions",
  "postmortem": "AI Postmortems",
};

const QUOTA_DESCRIPTIONS: Record<QuotaFeature, string> = {
  "auto-analyze": "Alerts auto-diagnosed by AI",
  "remediation": "Auto-fix with AI-generated PR",
  "chat": "Messages to Ask Inari",
  "pr-prediction": "Pre-deploy risk on PRs",
  "postmortem": "Auto-generated incident post-mortems",
};

function QuotaBar({ status }: { status: QuotaStatus }) {
  const colorClass =
    status.percentUsed >= 100 ? "bg-red-500" :
    status.percentUsed >= 80 ? "bg-amber-500" :
    "bg-emerald-500";

  return (
    <div className="py-2.5">
      <div className="flex items-baseline justify-between mb-1">
        <div className="flex-1">
          <span className="text-sm font-medium text-fg-base">
            {QUOTA_LABELS[status.feature]}
          </span>
          <span className="ml-2 text-xs text-zinc-600">
            {QUOTA_DESCRIPTIONS[status.feature]}
          </span>
        </div>
        <div className="text-xs tabular-nums">
          <span className="text-fg-strong font-semibold">{status.used.toLocaleString()}</span>
          <span className="text-zinc-500">/{status.limit.toLocaleString()}</span>
          <span className={`ml-2 ${
            status.percentUsed >= 100 ? "text-red-400" :
            status.percentUsed >= 80 ? "text-amber-400" :
            "text-zinc-500"
          }`}>{status.percentUsed}%</span>
        </div>
      </div>
      <div className="h-2 rounded-full bg-surface-inner overflow-hidden">
        <div
          className={`h-full transition-all ${colorClass}`}
          style={{ width: `${Math.min(100, status.percentUsed)}%` }}
        />
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  quotas,
  daysUntilReset,
}: {
  plan: "free" | "pro";
  quotas: QuotaStatus[];
  daysUntilReset: number;
}) {
  const anyExceeded = quotas.some((q) => q.exceeded);
  const anyNearLimit = quotas.some((q) => q.percentUsed >= 80 && !q.exceeded);

  return (
    <div className="rounded-xl border border-line bg-surface-dim overflow-hidden mb-8">
      {/* Header */}
      <div className={`px-5 py-4 border-b border-line ${plan === "pro" ? "bg-inari-accent/5" : ""}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {plan === "pro" ? (
              <Sparkles className="h-5 w-5 text-inari-accent" />
            ) : (
              <Brain className="h-5 w-5 text-zinc-500" />
            )}
            <h2 className="text-base font-semibold text-fg-strong">
              {plan === "pro" ? "Pro Plan" : "Free Plan"}
            </h2>
            {plan === "free" && (
              <span className="ml-2 text-xs text-zinc-500">
                Upgrade for 10x more
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500">
            Resets in {daysUntilReset} {daysUntilReset === 1 ? "day" : "days"}
          </div>
        </div>
      </div>

      {/* Quotas */}
      <div className="px-5 py-3">
        {quotas.map((q) => (
          <QuotaBar key={q.feature} status={q} />
        ))}
      </div>

      {/* CTA banner */}
      {plan === "free" && (anyExceeded || anyNearLimit) && (
        <div className={`px-5 py-3 border-t border-line ${
          anyExceeded ? "bg-red-500/5" : "bg-amber-500/5"
        }`}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-2">
              <AlertCircle className={`h-4 w-4 mt-0.5 shrink-0 ${
                anyExceeded ? "text-red-400" : "text-amber-400"
              }`} />
              <div className="text-sm">
                {anyExceeded ? (
                  <>
                    <span className="font-medium text-fg-strong">You&apos;ve hit a limit.</span>
                    <span className="text-zinc-500"> Upgrade to Pro for 10x more allocations.</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-fg-strong">You&apos;re close to a limit.</span>
                    <span className="text-zinc-500"> Upgrade now to avoid interruption.</span>
                  </>
                )}
              </div>
            </div>
            <Link
              href="/pricing"
              className="shrink-0 rounded-md bg-inari-accent text-bg-base px-3 py-1.5 text-xs font-medium hover:bg-inari-accent/90 transition-colors"
            >
              Upgrade $12/mo →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function daysUntilNextMonth(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil((next.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function AIUsagePage() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) redirect("/login?callbackUrl=/analytics/ai-usage");

  const [data, quotas, userPlan] = await Promise.all([
    getUsageData(userId),
    getAllQuotaStatus(userId),
    getUserPlan(userId),
  ]);

  // Calculate trends
  const costDelta = data.thisMonth.cost - data.lastMonth.cost;
  const costDeltaPct = data.lastMonth.cost > 0
    ? Math.round((costDelta / data.lastMonth.cost) * 100)
    : null;

  const trend = costDelta === 0
    ? undefined
    : {
        direction: costDelta > 0 ? ("up" as const) : ("down" as const),
        text: costDeltaPct != null
          ? `${costDelta > 0 ? "+" : ""}${costDeltaPct}% vs last month`
          : `${formatCost(Math.abs(costDelta))} vs last month`,
      };

  // Budget progress
  const budgetPct = data.budget ? (data.thisMonth.cost / data.budget) * 100 : null;

  // Feature breakdown with percentages
  const totalFeatureCost = data.byFeature.reduce((acc, f) => acc + f.cost, 0);
  const featuresWithPct = data.byFeature.map((f) => ({
    ...f,
    percentage: totalFeatureCost > 0 ? (f.cost / totalFeatureCost) * 100 : 0,
  }));

  // Model breakdown
  const totalModelCost = data.byModel.reduce((acc, m) => acc + m.cost, 0);
  const modelsWithPct = data.byModel.map((m) => ({
    ...m,
    percentage: totalModelCost > 0 ? (m.cost / totalModelCost) * 100 : 0,
  }));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Brain className="h-6 w-6 text-inari-accent" />
          <h1 className="text-2xl font-semibold text-fg-strong">AI Usage</h1>
        </div>
        <p className="text-sm text-zinc-500">
          Your monthly AI quotas + BYOK spending broken down by feature, model, and date.
        </p>
      </div>

      {/* Plan & Quotas */}
      <PlanCard
        plan={userPlan.plan}
        quotas={quotas}
        daysUntilReset={daysUntilNextMonth()}
      />

      {/* Top stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        <StatCard
          label="This month"
          value={formatCost(data.thisMonth.cost)}
          subtitle={`${data.thisMonth.calls.toLocaleString()} API calls`}
          icon={DollarSign}
          trend={trend}
        />
        <StatCard
          label="Input tokens"
          value={formatTokens(data.thisMonth.inputTokens)}
          subtitle={
            data.thisMonth.cachedTokens > 0
              ? `${formatTokens(data.thisMonth.cachedTokens)} cached (discounted)`
              : "No cache hits this period"
          }
          icon={Zap}
        />
        <StatCard
          label="Output tokens"
          value={formatTokens(data.thisMonth.outputTokens)}
          subtitle="Generated by models"
          icon={Activity}
        />
        <StatCard
          label="Last month"
          value={formatCost(data.lastMonth.cost)}
          subtitle={`${data.lastMonth.calls.toLocaleString()} API calls`}
          icon={Calendar}
        />
      </div>

      {/* Budget progress bar */}
      {data.budget != null && (
        <div className="mb-8 rounded-xl border border-line bg-surface-dim px-5 py-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-medium text-fg-strong">Monthly budget</span>
            <span className="text-sm tabular-nums">
              <span className="text-fg-strong font-semibold">{formatCost(data.thisMonth.cost)}</span>
              <span className="text-zinc-500"> / {formatCost(data.budget)}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-inner overflow-hidden">
            <div
              className={`h-full transition-all ${
                (budgetPct ?? 0) > 100 ? "bg-red-500" :
                (budgetPct ?? 0) > 80 ? "bg-amber-500" :
                "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, budgetPct ?? 0)}%` }}
            />
          </div>
          {(budgetPct ?? 0) > 80 && (
            <p className={`mt-2 text-xs ${(budgetPct ?? 0) > 100 ? "text-red-400" : "text-amber-400"}`}>
              {(budgetPct ?? 0) > 100
                ? `You're ${formatCost(data.thisMonth.cost - data.budget)} over budget this month.`
                : `You've used ${Math.round(budgetPct ?? 0)}% of your monthly budget.`}
            </p>
          )}
        </div>
      )}

      {/* Daily chart */}
      <div className="mb-8 rounded-xl border border-line bg-surface-dim px-5 py-5">
        <h2 className="text-sm font-medium text-fg-strong mb-4">Last 30 days</h2>
        <DailyChart data={data.daily} />
      </div>

      {/* Breakdown by feature and model side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="rounded-xl border border-line bg-surface-dim px-5 py-5">
          <h2 className="text-sm font-medium text-fg-strong mb-4">By feature</h2>
          {featuresWithPct.length === 0 ? (
            <p className="text-sm text-zinc-500">No data yet this month.</p>
          ) : (
            <div className="space-y-1">
              {featuresWithPct.map((f) => (
                <BarRow
                  key={f.feature}
                  label={FEATURE_LABELS[f.feature] ?? f.feature}
                  cost={f.cost}
                  percentage={f.percentage}
                  calls={f.calls}
                />
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface-dim px-5 py-5">
          <h2 className="text-sm font-medium text-fg-strong mb-4">By model</h2>
          {modelsWithPct.length === 0 ? (
            <p className="text-sm text-zinc-500">No data yet this month.</p>
          ) : (
            <div className="space-y-1">
              {modelsWithPct.map((m) => (
                <BarRow
                  key={`${m.provider}-${m.model}`}
                  label={m.model}
                  cost={m.cost}
                  percentage={m.percentage}
                  calls={m.calls}
                  sub={PROVIDER_LABELS[m.provider] ?? m.provider}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Top expensive alerts and sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-line bg-surface-dim px-5 py-5">
          <h2 className="text-sm font-medium text-fg-strong mb-4">Top alerts by cost</h2>
          {data.topAlerts.length === 0 ? (
            <p className="text-sm text-zinc-500">No alert-linked calls yet.</p>
          ) : (
            <div className="space-y-2">
              {data.topAlerts.map((a) => (
                <Link
                  key={a.alertId}
                  href={`/alerts/${a.alertId}`}
                  className="flex items-start justify-between gap-3 p-2 -m-2 rounded-lg hover:bg-surface-inner transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg-base truncate">{a.title}</div>
                    <div className="text-xs text-zinc-500">{a.calls} {a.calls === 1 ? "call" : "calls"}</div>
                  </div>
                  <div className="text-sm font-semibold text-fg-strong tabular-nums shrink-0">
                    {formatCost(a.cost)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface-dim px-5 py-5">
          <h2 className="text-sm font-medium text-fg-strong mb-4">Top remediation sessions</h2>
          {data.topSessions.length === 0 ? (
            <p className="text-sm text-zinc-500">No remediation sessions yet.</p>
          ) : (
            <div className="space-y-2">
              {data.topSessions.map((s) => (
                <Link
                  key={s.sessionId}
                  href={`/alerts/${s.alertId}`}
                  className="flex items-start justify-between gap-3 p-2 -m-2 rounded-lg hover:bg-surface-inner transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg-base truncate">{s.alertTitle}</div>
                    <div className="text-xs text-zinc-500">{s.calls} {s.calls === 1 ? "call" : "calls"}</div>
                  </div>
                  <div className="text-sm font-semibold text-fg-strong tabular-nums shrink-0">
                    {formatCost(s.cost)}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer note */}
      <div className="mt-8 rounded-lg border border-line bg-surface-inner px-4 py-3 text-xs text-zinc-500">
        <strong className="text-zinc-400">How this is calculated:</strong> Every AI call logs
        input/output token counts from the provider response. Cost is computed using published
        per-model rates (USD per 1M tokens) at the time of call. Cached input tokens are billed
        at the discounted rate (typically 10% of full price). Numbers may differ slightly from
        your provider&apos;s official billing due to rounding and pricing updates.
      </div>
    </div>
  );
}
