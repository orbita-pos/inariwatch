/**
 * SLO Check Job — Fase 12 Part A
 *
 * Triggers /api/cron/slo-check on the web app. The web route owns the
 * measurement query + slo_events upsert; this job only controls the
 * cadence (every 5 minutes) and surfaces failures in worker logs.
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function runSLOCheck(): Promise<void> {
  if (!APP_URL) {
    console.log("[slo-check] No APP_URL — skipping");
    return;
  }

  try {
    const res = await fetch(`${APP_URL}/api/cron/slo-check`, {
      method: "GET",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.error(`[slo-check] Failed (${res.status})`);
      return;
    }

    const body = (await res.json().catch(() => ({}))) as {
      breaches?: unknown[];
      openedOrUpdated?: number;
      resolved?: number;
    };
    const breaches = Array.isArray(body.breaches) ? body.breaches.length : 0;
    console.log(
      `[slo-check] ok breaches=${breaches} opened=${body.openedOrUpdated ?? 0} resolved=${body.resolved ?? 0}`
    );
  } catch (err) {
    console.error("[slo-check] Error:", err instanceof Error ? err.message : String(err));
  }
}
