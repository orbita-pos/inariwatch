import { db, notificationChannels, notificationLogs, notificationQueue, alerts as alertsTable, projects, severityMeetsMinimum } from "@/lib/db";
import { eq, and, lte, asc, inArray } from "drizzle-orm";
import { sendTelegram } from "./telegram";
import { sendSlack } from "./slack";
import { sendPushNotification } from "./push";
import { sendEmail } from "./email";
import { checkEmailRateLimit, isEmailSuppressed } from "./rate-limit";
import { formatBatchDigestEmail } from "./digest-email";
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
  if (alert.stormId) {
    return [
      `🚨 <b>[INCIDENT STORM]</b> Multiple alerts detected!`,
      ``,
      `<b>Project:</b> ${escapeHtml(projectName)}`,
      `Over 5 alerts fired in the last 5 minutes. Individual notifications are temporarily suppressed.`,
      ``,
      `<i>Latest alert:</i> ${escapeHtml(alert.title)}`,
    ].join("\n");
  }

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
  if (alert.stormId) {
    return [
      `🚨 *[INCIDENT STORM]* Multiple alerts detected!`,
      ``,
      `*Project:* ${projectName}`,
      `Over 5 alerts fired in the last 5 minutes. Individual notifications are temporarily suppressed.`,
      ``,
      `_Latest alert:_ ${alert.title}`,
    ].join("\n");
  }

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
              <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 22px; font-weight: 700; letter-spacing: 4px; color: #e63946;">INARIWATCH</span>
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
                  <td align="center" style="background-color: #e63946; border-radius: 24px;">
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
                      <span style="color: #e63946; font-weight: 600; letter-spacing: 1px;">INARIWATCH</span> &nbsp;&mdash;&nbsp; Proactive developer monitoring
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
 * Enqueue notifications for a new alert.
 *
 * Smart email routing:
 * - Push / Telegram / Slack → always immediate (free channels)
 * - Email + critical severity → immediate (never delay a critical alert)
 * - Email + non-critical → status "digest" (batched every cron cycle, ~5 min)
 *
 * This reduces email volume by ~75% while guaranteeing zero-delay on critical.
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
  const isCritical = alert.severity === "critical";

  for (const channel of activeChannels) {
    // Email non-critical → digest batch; everything else → immediate
    const isDigest = channel.type === "email" && !isCritical;

    await db.insert(notificationQueue).values({
      alertId: alert.id,
      channelId: channel.id,
      status: isDigest ? "digest" : "pending",
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
      
      const ackSig = signValue(alert.id);
      const resolveSig = signValue(alert.id);
      const reply_markup = {
        inline_keyboard: [
          [
            { text: "👁️ Acknowledge", url: `${APP_URL}/api/actions/ack?id=${alert.id}&sig=${ackSig}` },
            { text: "✅ Resolve", url: `${APP_URL}/api/actions/resolve?id=${alert.id}&sig=${resolveSig}` }
          ]
        ]
      };

      const result = await sendTelegram(
        { bot_token: config.bot_token, chat_id: config.chat_id },
        message,
        reply_markup
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
      const subject = alert.stormId 
        ? `🚨 [INCIDENT STORM] Multiple alerts for ${project.name}`
        : `[${alert.severity.toUpperCase()}] ${alert.title}`;
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

// ── Email digest processor ───────────────────────────────────────────────────

/**
 * Process batched email notifications.
 *
 * Groups all "digest" queue items by channel (= same user email),
 * renders ONE digest email per user with all pending alerts,
 * and sends it. Runs every cron cycle (~5 min).
 *
 * Result: user gets max 1 email per 5 minutes instead of N individual emails.
 * Critical alerts bypass this entirely and are sent immediately.
 */
export async function processEmailDigests(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  // Fetch all digest-pending email items
  const items = await db
    .select()
    .from(notificationQueue)
    .where(eq(notificationQueue.status, "digest"))
    .orderBy(asc(notificationQueue.priority), asc(notificationQueue.createdAt))
    .limit(200);

  if (items.length === 0) return { sent: 0, failed: 0 };

  // Group by channelId (one email per user channel)
  const byChannel = new Map<string, typeof items>();
  for (const item of items) {
    const group = byChannel.get(item.channelId) ?? [];
    group.push(item);
    byChannel.set(item.channelId, group);
  }

  for (const [channelId, queueItems] of byChannel) {
    // Load channel
    const [channel] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId))
      .limit(1);

    if (!channel || !channel.isActive || channel.type !== "email") {
      const ids = queueItems.map((q) => q.id);
      await db
        .update(notificationQueue)
        .set({ status: "failed", error: "Channel inactive or not email" })
        .where(inArray(notificationQueue.id, ids));
      failed += ids.length;
      continue;
    }

    const config = decryptConfig(channel.config) as Record<string, string>;

    // Check suppression
    if (await isEmailSuppressed(config.email)) {
      const ids = queueItems.map((q) => q.id);
      await db
        .update(notificationQueue)
        .set({ status: "failed", error: "Email suppressed" })
        .where(inArray(notificationQueue.id, ids));
      failed += ids.length;
      continue;
    }

    // Check rate limit
    const [project] = await db
      .select({ userId: projects.userId })
      .from(projects)
      .innerJoin(alertsTable, eq(alertsTable.projectId, projects.id))
      .where(eq(alertsTable.id, queueItems[0].alertId))
      .limit(1);

    if (project) {
      const rateCheck = await checkEmailRateLimit(project.userId);
      if (!rateCheck.allowed) {
        // Reschedule — will be picked up next cron cycle
        continue;
      }
    }

    // Load all alerts for this batch
    const alertIds = queueItems.map((q) => q.alertId);
    const digestAlerts = await db
      .select()
      .from(alertsTable)
      .where(inArray(alertsTable.id, alertIds));

    if (digestAlerts.length === 0) {
      const ids = queueItems.map((q) => q.id);
      await db
        .update(notificationQueue)
        .set({ status: "failed", error: "No alerts found" })
        .where(inArray(notificationQueue.id, ids));
      failed += ids.length;
      continue;
    }

    // Load project names for the alerts
    const projectIds = [...new Set(digestAlerts.map((a) => a.projectId))];
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    const projectMap = new Map(projectRows.map((p) => [p.id, p.name]));

    // Pre-create log entry for tracking
    const [logEntry] = await db
      .insert(notificationLogs)
      .values({
        alertId: digestAlerts[0].id, // reference first alert
        channelId,
        status: "pending",
      })
      .returning();

    // Build and send
    const unsubToken = signValue(config.email.toLowerCase());
    const unsubscribeUrl = `${APP_URL}/api/notifications/unsubscribe?email=${encodeURIComponent(config.email)}&token=${unsubToken}`;

    let subject: string;
    let html: string;

    if (digestAlerts.length === 1) {
      // Single alert — use individual email format
      const alert = digestAlerts[0];
      subject = `[${alert.severity.toUpperCase()}] ${alert.title}`;
      html = formatAlertEmail(alert, projectMap.get(alert.projectId) ?? "Unknown", unsubscribeUrl, logEntry.id);
    } else {
      // Multiple alerts — use batch digest format
      const criticalCount = digestAlerts.filter((a) => a.severity === "critical").length;
      subject = `${digestAlerts.length} new alerts${criticalCount > 0 ? ` (${criticalCount} critical)` : ""}`;
      html = formatBatchDigestEmail(
        digestAlerts.map((a) => ({
          id: a.id,
          title: a.title,
          severity: a.severity,
          project: projectMap.get(a.projectId) ?? "Unknown",
          createdAt: a.createdAt,
        })),
        unsubscribeUrl,
        logEntry.id
      );
    }

    const result = await sendEmail({ email: config.email }, subject, html, { unsubscribeUrl });

    const ids = queueItems.map((q) => q.id);
    if (result.ok) {
      await db
        .update(notificationQueue)
        .set({ status: "sent" })
        .where(inArray(notificationQueue.id, ids));
      await db
        .update(notificationLogs)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(notificationLogs.id, logEntry.id));
      sent += ids.length;
    } else {
      await db
        .update(notificationQueue)
        .set({ status: "failed", error: result.error })
        .where(inArray(notificationQueue.id, ids));
      await db
        .update(notificationLogs)
        .set({ status: "failed", error: result.error })
        .where(eq(notificationLogs.id, logEntry.id));
      failed += ids.length;
    }
  }

  return { sent, failed };
}

// ── Legacy sync method (kept for backwards compat, now uses queue) ──────────

export async function notifyAlert(alert: Alert): Promise<number> {
  const enqueued = await enqueueAlert(alert);
  if (enqueued === 0) return 0;
  const result = await processNotificationQueue(enqueued);
  return result.sent;
}
