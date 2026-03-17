import { db, notificationChannels, notificationLogs, notificationQueue, projects, severityMeetsMinimum } from "@/lib/db";
import { eq, and, lte, asc } from "drizzle-orm";
import { sendTelegram } from "./telegram";
import { sendSlack } from "./slack";
import { sendPushNotification } from "./push";
import { sendEmail } from "./email";
import { checkEmailRateLimit, isEmailSuppressed } from "./rate-limit";
import { signValue } from "@/lib/webhooks/shared";
import { decryptConfig } from "@/lib/crypto";
import type { Alert } from "@/lib/db";

const MAX_RETRIES = 3;
const RETRY_DELAYS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
  info: "\u{1F535}",
};

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function formatAlertMessage(alert: Alert, projectName: string): string {
  const emoji = SEVERITY_EMOJI[alert.severity] ?? "";
  const sources = alert.sourceIntegrations.join(", ");
  return [
    `${emoji} <b>[${alert.severity.toUpperCase()}]</b> ${escapeHtml(alert.title)}`,
    ``,
    `<b>Project:</b> ${escapeHtml(projectName)}`,
    `<b>Source:</b> ${sources}`,
    ``,
    escapeHtml(truncate(alert.body, 500)),
  ].join("\n");
}

function formatSlackMessage(alert: Alert, projectName: string): string {
  const emoji = SEVERITY_EMOJI[alert.severity] ?? "";
  const sources = alert.sourceIntegrations.join(", ");
  return [
    `${emoji} *[${alert.severity.toUpperCase()}]* ${alert.title}`,
    ``,
    `*Project:* ${projectName}`,
    `*Source:* ${sources}`,
    ``,
    truncate(alert.body, 500),
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#e63946",
  warning: "#eab308",
  info: "#3b82f6",
};

const APP_URL = process.env.NEXTAUTH_URL ?? "https://inariwatch.com";

function formatAlertEmail(
  alert: Alert,
  projectName: string,
  unsubscribeUrl: string,
  trackingLogId: string
): string {
  const color = SEVERITY_COLOR[alert.severity] ?? "#71717a";
  const sources = alert.sourceIntegrations.join(", ");
  const openPixelUrl = `${APP_URL}/api/notifications/track/open?id=${trackingLogId}`;
  const dashboardUrl = `${APP_URL}/api/notifications/track/click?id=${trackingLogId}&url=${encodeURIComponent(`${APP_URL}/alerts/${alert.id}`)}`;
  const severityLabel = alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(alert.title)}</title>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #09090b;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%;">

          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 700; letter-spacing: 4px; color: #7C3AED;">KAIRO</span>
            </td>
          </tr>

          <!-- Alert card -->
          <tr>
            <td style="padding: 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #18181b; border-radius: 12px; overflow: hidden;">
                <tr>
                  <td width="4" style="background-color: ${color}; width: 4px;"></td>
                  <td style="padding: 24px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

                    <!-- Severity badge -->
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 16px;">
                      <tr>
                        <td style="background-color: ${color}; border-radius: 20px; padding: 4px 12px;">
                          <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 700; color: #ffffff; text-transform: uppercase; letter-spacing: 0.8px;">${severityLabel}</span>
                        </td>
                      </tr>
                    </table>

                    <!-- Title -->
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 600; color: #fafafa; margin: 0 0 8px 0; line-height: 1.4;">${escapeHtml(alert.title)}</p>

                    <!-- Project / Source -->
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #71717a; margin: 0 0 20px 0;">
                      ${escapeHtml(projectName)} &nbsp;&middot;&nbsp; ${sources}
                    </p>

                    <!-- Divider -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px;">
                      <tr>
                        <td style="border-top: 1px solid #27272a; font-size: 0; line-height: 0;" height="1">&nbsp;</td>
                      </tr>
                    </table>

                    <!-- Body -->
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #a1a1aa; line-height: 1.7; margin: 0; white-space: pre-wrap;">${escapeHtml(truncate(alert.body, 800))}</p>

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td align="center" style="padding: 28px 0 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="background-color: #7C3AED; border-radius: 24px;">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; padding: 12px 32px; text-decoration: none;">View in InariWatch</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 36px 0 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-top: 1px solid #1e1e22; padding-top: 24px; text-align: center;">
                    <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; color: #3f3f46; margin: 0 0 6px 0;">
                      <span style="color: #7C3AED; font-weight: 600; letter-spacing: 1px;">KAIRO</span> &nbsp;&mdash;&nbsp; Proactive developer monitoring
                    </p>
                    <a href="${unsubscribeUrl}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #52525b; text-decoration: underline;">
                      Unsubscribe from email alerts
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <img src="${openPixelUrl}" width="1" height="1" alt="" style="display: block; width: 1px; height: 1px; border: 0;" />
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Queue-based notification system ─────────────────────────────────────────

/**
 * Enqueue notifications for a new alert. Does NOT send them immediately.
 * Priority is derived from alert severity (critical=0, warning=1, info=2).
 */
export async function enqueueAlert(alert: Alert): Promise<number> {
  const [project] = await db
    .select({ userId: projects.userId, name: projects.name })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  if (!project) return 0;

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, project.userId));

  const activeChannels = channels.filter(
    (ch) => ch.isActive && ch.verifiedAt && severityMeetsMinimum(alert.severity, ch.minSeverity)
  );
  if (activeChannels.length === 0) return 0;

  const priority = SEVERITY_PRIORITY[alert.severity] ?? 1;

  for (const channel of activeChannels) {
    await db.insert(notificationQueue).values({
      alertId: alert.id,
      channelId: channel.id,
      status: "pending",
      priority,
    });
  }

  return activeChannels.length;
}

/**
 * Process pending items in the notification queue.
 * Items are processed in priority order (critical first).
 * Returns { sent, failed, skipped }.
 */
export async function processNotificationQueue(
  batchSize = 50
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = new Date();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Fetch pending items ordered by priority (0=critical first), then by creation time
  const items = await db
    .select()
    .from(notificationQueue)
    .where(
      and(
        eq(notificationQueue.status, "pending"),
        lte(notificationQueue.nextRetry, now)
      )
    )
    .orderBy(asc(notificationQueue.priority), asc(notificationQueue.createdAt))
    .limit(batchSize);

  for (const item of items) {
    // Mark as processing
    await db
      .update(notificationQueue)
      .set({ status: "processing" })
      .where(eq(notificationQueue.id, item.id));

    // Load channel
    const [channel] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, item.channelId))
      .limit(1);

    if (!channel || !channel.isActive) {
      await markQueueItem(item.id, "failed", "Channel inactive or deleted");
      failed++;
      continue;
    }

    // Load alert
    const { alerts } = await import("@/lib/db");
    const [alert] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.id, item.alertId))
      .limit(1);

    if (!alert) {
      await markQueueItem(item.id, "failed", "Alert not found");
      failed++;
      continue;
    }

    // Load project
    const [project] = await db
      .select({ userId: projects.userId, name: projects.name })
      .from(projects)
      .where(eq(projects.id, alert.projectId))
      .limit(1);

    if (!project) {
      await markQueueItem(item.id, "failed", "Project not found");
      failed++;
      continue;
    }

    const config = decryptConfig(channel.config) as Record<string, string>;
    let status: "sent" | "failed" = "failed";
    let error: string | undefined;

    if (channel.type === "telegram") {
      const message = formatAlertMessage(alert, project.name);
      const result = await sendTelegram(
        { bot_token: config.bot_token, chat_id: config.chat_id },
        message
      );
      if (result.ok) {
        status = "sent";
        sent++;
      } else {
        error = result.error;
      }
    } else if (channel.type === "slack") {
      const message = formatSlackMessage(alert, project.name);
      const result = await sendSlack(
        { webhook_url: config.webhook_url },
        message
      );
      if (result.ok) {
        status = "sent";
        sent++;
      } else {
        error = result.error;
      }
    } else if ((channel.type as string) === "push") {
      const pushConfig = channel.config as { endpoint: string; keys: { p256dh: string; auth: string } };
      const pushResult = await sendPushNotification(
        { endpoint: pushConfig.endpoint, keys: { p256dh: pushConfig.keys.p256dh, auth: pushConfig.keys.auth } },
        { title: `[${alert.severity.toUpperCase()}] ${alert.title}`, body: truncate(alert.body, 200), severity: alert.severity, alertId: alert.id }
      );
      if (pushResult.ok) {
        status = "sent";
        sent++;
      } else {
        error = pushResult.error;
      }
    } else if (channel.type === "email") {
      // Check suppression list
      if (await isEmailSuppressed(config.email)) {
        await markQueueItem(item.id, "failed", "Email suppressed");
        skipped++;
        continue;
      }

      // Check rate limit
      const rateCheck = await checkEmailRateLimit(project.userId);
      if (!rateCheck.allowed) {
        const nextRetry = new Date(Date.now() + 5 * 60 * 1000);
        await db
          .update(notificationQueue)
          .set({ status: "pending", nextRetry, error: rateCheck.reason })
          .where(eq(notificationQueue.id, item.id));
        skipped++;
        continue;
      }

      // Pre-create the notification log to get an ID for tracking
      const [logEntry] = await db
        .insert(notificationLogs)
        .values({
          alertId: item.alertId,
          channelId: item.channelId,
          status: "pending",
        })
        .returning();

      const unsubToken = signValue(config.email.toLowerCase());
      const unsubscribeUrl = `${APP_URL}/api/notifications/unsubscribe?email=${encodeURIComponent(config.email)}&token=${unsubToken}`;
      const subject = `[${alert.severity.toUpperCase()}] ${alert.title}`;
      const html = formatAlertEmail(alert, project.name, unsubscribeUrl, logEntry.id);
      const result = await sendEmail({ email: config.email }, subject, html, { unsubscribeUrl });

      if (result.ok) {
        status = "sent";
        sent++;
      } else {
        error = result.error;
      }

      // Update the pre-created log entry
      await db
        .update(notificationLogs)
        .set({ status, error, sentAt: status === "sent" ? new Date() : undefined })
        .where(eq(notificationLogs.id, logEntry.id));

      // Mark queue item and skip the generic log insert below
      if (status === "sent") {
        await markQueueItem(item.id, "sent");
      } else {
        const attempts = item.attempts + 1;
        if (attempts >= MAX_RETRIES) {
          await markQueueItem(item.id, "failed", error);
          failed++;
        } else {
          const delay = RETRY_DELAYS[attempts - 1] ?? 900_000;
          await db
            .update(notificationQueue)
            .set({ status: "pending", attempts, error, nextRetry: new Date(Date.now() + delay) })
            .where(eq(notificationQueue.id, item.id));
        }
      }
      continue; // email already logged above
    }

    // For non-email channels: update queue and log
    if (status === "sent") {
      await markQueueItem(item.id, "sent");
    } else {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_RETRIES) {
        await markQueueItem(item.id, "failed", error);
        failed++;
      } else {
        const delay = RETRY_DELAYS[attempts - 1] ?? 900_000;
        await db
          .update(notificationQueue)
          .set({ status: "pending", attempts, error, nextRetry: new Date(Date.now() + delay) })
          .where(eq(notificationQueue.id, item.id));
      }
    }

    await db.insert(notificationLogs).values({
      alertId: item.alertId,
      channelId: item.channelId,
      status,
      error,
    });
  }

  return { sent, failed, skipped };
}

async function markQueueItem(id: string, status: string, error?: string) {
  await db
    .update(notificationQueue)
    .set({ status, error })
    .where(eq(notificationQueue.id, id));
}

// ── Legacy sync method (kept for backwards compat, now uses queue) ──────────

export async function notifyAlert(alert: Alert): Promise<number> {
  const enqueued = await enqueueAlert(alert);
  if (enqueued === 0) return 0;
  const result = await processNotificationQueue(enqueued);
  return result.sent;
}
