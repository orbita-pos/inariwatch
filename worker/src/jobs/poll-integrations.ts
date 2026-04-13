/**
 * Poll Integrations Job — replaces Go cron → Vercel fan-out.
 *
 * The worker orchestrates polling timing. Vercel sub-routes do the actual
 * work (have integration configs, API keys, createAlertIfNew logic).
 *
 * Key optimization: GitHub/Vercel/Sentry are webhook-driven — polling
 * is only needed for services without webhooks (npm, postgres, expo).
 * A weekly fallback poll for webhook services catches any missed events.
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

/** Services that MUST be polled (no webhook support). */
const ALWAYS_POLL = ["npm", "postgres", "expo"] as const;

/** Services with webhooks — poll only as weekly fallback. */
const WEBHOOK_SERVICES = ["github", "vercel", "sentry"] as const;

interface PollResult {
  service: string;
  ok: boolean;
  status?: number;
  durationMs: number;
}

/**
 * Poll all services without webhooks.
 * Runs every 2 minutes via repeatable BullMQ job.
 */
export async function pollIntegrations(): Promise<{ results: PollResult[] }> {
  const results: PollResult[] = [];

  // Poll services that require it (no webhook alternative)
  const polls = ALWAYS_POLL.map((service) => pollSubRoute(service));
  const settled = await Promise.allSettled(polls);

  for (let i = 0; i < ALWAYS_POLL.length; i++) {
    const service = ALWAYS_POLL[i];
    const result = settled[i];
    if (result.status === "fulfilled") {
      results.push(result.value);
    } else {
      results.push({ service, ok: false, durationMs: 0 });
    }
  }

  // Also run correlation + anomaly after polling
  await callVercelEndpoint("/api/cron/poll/correlation");

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  if (ok > 0 || fail > 0) {
    console.log(`[poll] ok=${ok} fail=${fail}`);
  }

  return { results };
}

/**
 * Weekly fallback poll for webhook services.
 * Catches events missed by webhooks (rare but possible).
 */
export async function pollWebhookFallback(): Promise<{ results: PollResult[] }> {
  const results: PollResult[] = [];

  for (const service of WEBHOOK_SERVICES) {
    const result = await pollSubRoute(service);
    results.push(result);
  }

  console.log(`[poll-fallback] Polled ${WEBHOOK_SERVICES.length} webhook services`);
  return { results };
}

async function pollSubRoute(service: string): Promise<PollResult> {
  if (!APP_URL) return { service, ok: false, durationMs: 0 };

  const start = Date.now();
  try {
    const res = await fetch(`${APP_URL}/api/cron/poll/${service}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: AbortSignal.timeout(30000),
    });

    return {
      service,
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      service,
      ok: false,
      durationMs: Date.now() - start,
    };
  }
}

async function callVercelEndpoint(path: string): Promise<void> {
  if (!APP_URL) return;
  try {
    await fetch(`${APP_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Non-blocking
  }
}
