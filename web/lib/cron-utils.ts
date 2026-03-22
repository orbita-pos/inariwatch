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
  | "escalate"
  | "uptime"
  | "digest";

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
