/**
 * Digest Job — triggers hourly digest email processing.
 *
 * Like flush-notifications, the worker controls timing and Vercel
 * does the actual sending (has Resend + email templates).
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function runDigest(): Promise<void> {
  if (!APP_URL) {
    console.log("[digest] No APP_URL — skipping");
    return;
  }

  try {
    const res = await fetch(`${APP_URL}/api/cron/digest`, {
      method: "GET",
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error(`[digest] Failed (${res.status})`);
    } else {
      console.log("[digest] Completed");
    }
  } catch (err) {
    console.error("[digest] Error:", err instanceof Error ? err.message : String(err));
  }
}
