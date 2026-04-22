/**
 * Shared utilities for all cron routes.
 *
 * cronLog()      — structured JSON logging (visible in Vercel Logs / any log aggregator)
 * pingCronHealth() — fires a GET to CRON_HEALTH_URL_<ROUTE> after each run.
 *                    Compatible with Sentry Cron Monitors, Healthchecks.io,
 *                    Cronitor, Better Uptime, UptimeRobot — just paste the ping URL.
 *
 * Env vars (optional, one per cron route):
 *   CRON_HEALTH_URL_POLL           — /api/cron/poll  (orchestrator)
 *   CRON_HEALTH_URL_POLL_GITHUB    — /api/cron/poll/github
 *   CRON_HEALTH_URL_POLL_VERCEL    — /api/cron/poll/vercel
 *   CRON_HEALTH_URL_POLL_SENTRY    — /api/cron/poll/sentry
 *   CRON_HEALTH_URL_POLL_UPTIME    — /api/cron/poll/uptime
 *   CRON_HEALTH_URL_POLL_POSTGRES  — /api/cron/poll/postgres
 *   CRON_HEALTH_URL_POLL_NPM       — /api/cron/poll/npm
 *   CRON_HEALTH_URL_ESCALATE       — /api/cron/escalate
 *   CRON_HEALTH_URL_UPTIME         — /api/cron/uptime
 *   CRON_HEALTH_URL_DIGEST         — /api/cron/digest
 */

export type CronRoute =
  | "poll"
  | "poll_github"
  | "poll_vercel"
  | "poll_sentry"
  | "poll_uptime"
  | "poll_postgres"
  | "poll_npm"
  | "poll_expo"
  | "escalate"
  | "uptime"
  | "digest"
  | "quota-reset"
  | "budget-alert"
  | "replay-retention"
  | "replay-stats"
  | "cleanup-ai-logs"
  | "whatif-retention"
  | "pool-rehydrate";

export function cronLog(
  route: CronRoute,
  payload: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      event: `cron_${route}`,
      ts: new Date().toISOString(),
      ...payload,
    })
  );
}

export async function pingCronHealth(
  route: CronRoute,
  ok: boolean
): Promise<void> {
  const key = `CRON_HEALTH_URL_${route.toUpperCase()}` as keyof NodeJS.ProcessEnv;
  const url = process.env[key];
  if (!url) return;

  try {
    // Most services accept a simple GET; Sentry uses ?status=ok|error
    const target = ok ? url : `${url}?status=error`;
    await fetch(target, { method: "GET", signal: AbortSignal.timeout(4000) });
  } catch {
    // Health ping failure must never break the cron response
  }
}

/**
 * Delete ai_usage_logs rows older than AI_LENS_RETENTION_DAYS (default 30).
 * Exposed but not yet registered — the caller (Hetzner Go scheduler or
 * Vercel cron) decides when to invoke it.
 *
 * TODO: register in Hetzner Go scheduler or Vercel cron.
 * Suggested: daily at 03:00 UTC to avoid peak load.
 * curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/cleanup-ai-logs
 */
export async function cleanupAIUsageLogs(): Promise<{
  deletedCount: number;
  retentionDays: number;
}> {
  const retentionDays = parseInt(process.env.AI_LENS_RETENTION_DAYS ?? "30", 10);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { db, aiUsageLogs } = await import("@/lib/db");
  const { lt } = await import("drizzle-orm");
  const result = await db.delete(aiUsageLogs).where(lt(aiUsageLogs.createdAt, cutoff));
  return {
    deletedCount: (result as { rowCount?: number }).rowCount ?? 0,
    retentionDays,
  };
}

/**
 * Concurrency-limited drop-in replacement for `Promise.allSettled`.
 *
 * Iterates `items` with at most `limit` parallel calls to `fn`. Returns
 * results in the same order as input (matching Promise.allSettled shape),
 * so existing post-loop code that checks `result.status === "fulfilled"`
 * keeps working.
 *
 * Used by the poll/* routes to bound the parallelism over integrations.
 * Without this, 1000 free integrations = 1000 simultaneous upstream API
 * calls (Sentry, Vercel, GitHub) every cron cycle — death spiral under
 * viral load.
 */
export async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  if (items.length === 0) return results;

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) return;
        try {
          const value = await fn(items[idx]);
          results[idx] = { status: "fulfilled", value };
        } catch (reason) {
          results[idx] = { status: "rejected", reason };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}
