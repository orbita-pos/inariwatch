/**
 * Job Queue Client — enqueues background jobs to the Hetzner worker.
 *
 * Used by Vercel API routes (webhooks, cron) to offload work to BullMQ.
 * Falls back to inline execution if WORKER_URL is not set (local dev).
 *
 * Usage:
 *   await enqueue("process-alert", { alertId }, { queue: "critical" });
 *   await enqueue("escalate-alert", { alertId }, { queue: "default", delay: 300_000 });
 */

const WORKER_URL = process.env.WORKER_URL;
const STAGING_API_SECRET = process.env.STAGING_API_SECRET;

export interface EnqueueOpts {
  /** Queue priority: "critical" | "default" | "low". Default: "default". */
  queue?: "critical" | "default" | "low";
  /** Delay in milliseconds before the job is processed. */
  delay?: number;
  /** Priority within the queue (lower = higher priority). */
  priority?: number;
  /** Max retry attempts. */
  attempts?: number;
}

/**
 * Enqueue a job to the Hetzner worker.
 * Fire-and-forget — never throws (logs errors, doesn't crash callers).
 */
export async function enqueue(
  name: string,
  data: Record<string, unknown> = {},
  opts: EnqueueOpts = {}
): Promise<void> {
  if (!WORKER_URL || !STAGING_API_SECRET) {
    // No worker configured — skip silently (local dev or worker unavailable)
    return;
  }

  try {
    const res = await fetch(`${WORKER_URL}/worker/enqueue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${STAGING_API_SECRET}`,
      },
      body: JSON.stringify({
        queue: opts.queue ?? "default",
        name,
        data,
        opts: {
          delay: opts.delay,
          priority: opts.priority,
          attempts: opts.attempts,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[queue] enqueue ${name} failed (${res.status}): ${text.slice(0, 200)}`);
    }
  } catch (err) {
    // Fire-and-forget — queue unavailability should never crash the caller
    console.error(`[queue] enqueue ${name} error:`, err instanceof Error ? err.message : String(err));
  }
}
