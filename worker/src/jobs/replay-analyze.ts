/**
 * Replay Analyze Job — triggers the Vercel analyze endpoint.
 *
 * The heavy lifting (R2 reads, Claude call, DB writes) runs on Vercel where
 * the AI client + DB connection already live. The worker's role is just to
 * debounce/retry the request with BullMQ's backoff semantics.
 *
 * Enqueued by /api/replay/ingest when a session's final block arrives.
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export interface ReplayAnalyzeData {
  sessionId: string;
  /** If true, re-analyze even if aiSummary is already set. */
  force?: boolean;
}

export async function analyzeReplayJob(data: ReplayAnalyzeData): Promise<void> {
  if (!APP_URL) {
    console.warn("[replay-analyze] APP_URL not set — skipping");
    return;
  }
  if (!CRON_SECRET) {
    console.warn("[replay-analyze] CRON_SECRET not set — skipping");
    return;
  }

  const url = `${APP_URL}/api/replay/${encodeURIComponent(data.sessionId)}/analyze`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({ force: data.force === true }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`analyze endpoint ${res.status}: ${body.slice(0, 200)}`);
    }

    console.log(`[replay-analyze] ${data.sessionId} ok`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Re-throw so BullMQ applies its backoff/retry policy
    throw new Error(`replay-analyze failed: ${msg}`);
  }
}
