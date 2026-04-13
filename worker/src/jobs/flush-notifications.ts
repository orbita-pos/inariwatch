/**
 * Flush Notifications Job — triggers notification processing.
 *
 * The worker controls WHEN to process (every 30s via repeatable job).
 * The actual sending is delegated to Vercel (has Resend, Slack SDK,
 * Telegram, Web Push deps + encrypted channel configs).
 *
 * This is an intermediate step. Full migration of notification sending
 * to the worker requires adding those deps + ENCRYPTION_KEY here.
 */

const APP_URL = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function flushNotifications(): Promise<{ sent: number; failed: number }> {
  if (!APP_URL) {
    console.log("[notifications] No APP_URL — skipping");
    return { sent: 0, failed: 0 };
  }

  try {
    const res = await fetch(`${APP_URL}/api/notifications/flush`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.error(`[notifications] Flush failed (${res.status})`);
      return { sent: 0, failed: 0 };
    }

    const data = await res.json() as { sent?: number; failed?: number };
    const sent = data.sent ?? 0;
    const failed = data.failed ?? 0;

    if (sent > 0 || failed > 0) {
      console.log(`[notifications] sent=${sent} failed=${failed}`);
    }

    return { sent, failed };
  } catch (err) {
    console.error("[notifications] Flush error:", err instanceof Error ? err.message : String(err));
    return { sent: 0, failed: 0 };
  }
}
