/**
 * Telegram auto-delivery — push alerts, deploy notifications, digests.
 * Mirrors web/lib/slack/send.ts functionality for Telegram.
 */

import { db, alerts, notificationChannels, projects, telegramUserLinks, substrateRecordings, remediationSessions, telegramMessageLinks } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { sendMessage } from "./bot";
import * as fmt from "./format";
import type { Alert } from "@/lib/db/schema";

// ── Send alert to all Telegram channels for a project ────────────────────────

export async function sendAlertToTelegram(alert: Alert): Promise<void> {
  const [project] = await db.select({ name: projects.name, userId: projects.userId }).from(projects).where(eq(projects.id, alert.projectId)).limit(1);
  if (!project) return;

  // Find all telegram channels for this user
  const channels = await db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.userId, project.userId), eq(notificationChannels.type, "telegram"), eq(notificationChannels.isActive, true)));

  const emoji = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟠" : "🔵";

  const text = [
    `${emoji} <b>${fmt.esc(alert.title)}</b>`,
    `<i>${fmt.esc(project.name)}</i> · ${alert.severity}`,
    "",
    alert.body ? fmt.esc(alert.body.slice(0, 800)) : "",
    alert.aiReasoning ? `\n<b>AI Diagnosis:</b>\n${fmt.esc(alert.aiReasoning.slice(0, 800))}` : "",
    `\nSources: ${(alert.sourceIntegrations ?? []).join(", ") || "capture"}`,
  ].filter(Boolean).join("\n");

  const buttons = [
    [
      { text: "👁️ Ack", callback_data: `ack:${alert.id}` },
      { text: "✅ Resolve", callback_data: `resolve:${alert.id}` },
      { text: "🔧 Fix", callback_data: `fix:${alert.id}` },
    ],
  ];

  for (const ch of channels) {
    const config = ch.config as { bot_token?: string; chat_id?: string };
    if (!config.bot_token || !config.chat_id) continue;

    try {
      const result = await sendMessage(config.bot_token, config.chat_id, text, {
        reply_markup: { inline_keyboard: buttons },
      });

      // Track message for thread context
      if (result.result?.message_id) {
        const msgId = result.result.message_id;

        // Store message link for thread context
        db.insert(telegramMessageLinks).values({
          chatId: config.chat_id,
          messageId: msgId,
          alertId: alert.id,
          type: "alert",
        }).catch(() => {});

        // Auto-attach enrichments
        setTimeout(() => attachSubstrate(config.bot_token!, config.chat_id!, alert.id, msgId).catch(() => {}), 5000);
        setTimeout(() => attachCommunityFix(config.bot_token!, config.chat_id!, alert, msgId).catch(() => {}), 3000);
      }
    } catch {}
  }

  // Tag on-call user for critical alerts
  if (alert.severity === "critical") {
    try {
      const { getCurrentOnCallUserId } = await import("@/lib/on-call");
      const onCallUserId = await getCurrentOnCallUserId(alert.projectId, 1);
      if (onCallUserId) {
        const [link] = await db.select().from(telegramUserLinks).where(eq(telegramUserLinks.userId, onCallUserId)).limit(1);
        if (link) {
          await sendMessage(link.botToken, link.chatId, `🚨 <b>Critical alert — you are on-call</b>\n${fmt.esc(alert.title)}\n\n/fix_${alert.id.slice(0, 8)}`);
        }
      }
    } catch {}
  }
}

// ── Attach substrate recording ───────────────────────────────────────────────

async function attachSubstrate(botToken: string, chatId: string, alertId: string, replyTo: number): Promise<void> {
  const [recording] = await db.select().from(substrateRecordings).where(eq(substrateRecordings.alertId, alertId)).limit(1);
  if (!recording) return;

  const categories = recording.categories as Record<string, number> | null;
  const catLines = categories ? Object.entries(categories).map(([k, v]) => `  • ${k}: ${v}`).join("\n") : "";

  const text = [
    `📼 <b>Substrate I/O Recording</b>`,
    `Duration: ${recording.durationMs ?? 0}ms · ${recording.eventCount ?? 0} events`,
    catLines ? `\n${catLines}` : "",
    recording.context ? `\n${fmt.esc(recording.context.slice(0, 500))}` : "",
  ].filter(Boolean).join("\n");

  await sendMessage(botToken, chatId, text, { reply_to_message_id: replyTo });
}

// ── Attach community fix suggestion ──────────────────────────────────────────

async function attachCommunityFix(botToken: string, chatId: string, alert: Alert, replyTo: number): Promise<void> {
  if (!alert.fingerprint) return;

  const { lookupCommunityFix } = await import("@/lib/ai/community-fix-lookup");
  const fix = await lookupCommunityFix(alert.fingerprint);
  if (!fix) return;

  const text = [
    `💡 <b>Community Fix Available</b>`,
    `${fix.successRate}% success rate · ${fix.totalApplications} teams`,
    `\n<b>Approach:</b> ${fmt.esc(fix.fixApproach)}`,
    fix.fixDescription ? fmt.esc(fix.fixDescription.slice(0, 300)) : "",
  ].filter(Boolean).join("\n");

  const buttons = [[
    { text: "✅ Apply Fix", callback_data: `apply_fix:${alert.id}` },
    { text: "👍 Worked", callback_data: `rate_yes:${fix.fixId}` },
    { text: "👎 Didn't", callback_data: `rate_no:${fix.fixId}` },
  ]];

  await sendMessage(botToken, chatId, text, { reply_to_message_id: replyTo, reply_markup: { inline_keyboard: buttons } });
}

// ── Send remediation progress ────────────────────────────────────────────────

export async function sendRemediationStep(
  botToken: string,
  chatId: string,
  replyTo: number,
  step: { type: string; message: string; status: string }
): Promise<void> {
  const emoji = step.status === "completed" ? "✅" : step.status === "failed" ? "❌" : "⏳";
  await sendMessage(botToken, chatId, `${emoji} ${fmt.esc(step.message)}`, { reply_to_message_id: replyTo });
}

export async function sendRemediationComplete(
  botToken: string,
  chatId: string,
  replyTo: number,
  session: { id: string; prUrl?: string | null; confidenceScore?: number | null; status: string }
): Promise<void> {
  const status = session.status === "completed" ? "✅ Completed" : "❌ Failed";
  let text = `<b>${status}</b>\nConfidence: ${session.confidenceScore ?? "?"}%`;
  if (session.prUrl) text += `\n<a href="${session.prUrl}">View PR</a>`;

  const buttons = session.status === "proposing" ? [[
    { text: "✅ Approve & Merge", callback_data: `approve_rem:${session.id}` },
    { text: "❌ Cancel", callback_data: `cancel_rem:${session.id}` },
  ]] : session.status === "failed" ? [[
    { text: "🔄 Retry", callback_data: `retry_rem:${session.id}` },
  ]] : [];

  await sendMessage(botToken, chatId, text, {
    reply_to_message_id: replyTo,
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
}

// ── Deploy notification ──────────────────────────────────────────────────────

export async function sendDeployNotification(
  botToken: string,
  chatId: string,
  projectName: string,
  status: "success" | "failed",
  branch: string,
  url?: string
): Promise<void> {
  const emoji = status === "success" ? "🟢" : "🔴";
  let text = `${emoji} <b>Deploy ${status}</b>\n<i>${fmt.esc(projectName)}</i> · ${fmt.esc(branch)}`;
  if (url) text += `\n${url}`;
  if (status === "success") text += `\n\n<i>Monitoring for 15 minutes...</i>`;
  await sendMessage(botToken, chatId, text);
}

// ── Incident storm ───────────────────────────────────────────────────────────

export async function sendIncidentStorm(
  botToken: string,
  chatId: string,
  alertCount: number,
  titles: string[],
  alertId?: string
): Promise<void> {
  const titleList = titles.slice(0, 5).map((t) => `  • ${fmt.esc(t.slice(0, 60))}`).join("\n");
  const text = `🚨 <b>Incident Storm — ${alertCount} alerts</b>\n\n${titleList}${alertCount > 5 ? `\n  ... and ${alertCount - 5} more` : ""}`;

  const buttons = alertId ? [[{ text: "📝 Generate Postmortem", callback_data: `postmortem:${alertId}` }]] : [];

  await sendMessage(botToken, chatId, text, {
    reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
  });
}

// ── Incident storm for a project (finds Telegram channels) ───────────────────

export async function sendIncidentStormToProject(
  projectId: string,
  alertCount: number,
  titles: string[],
  alertId?: string
): Promise<void> {
  const [project] = await db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return;

  const channels = await db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.userId, project.userId), eq(notificationChannels.type, "telegram"), eq(notificationChannels.isActive, true)));

  for (const ch of channels) {
    const config = ch.config as { bot_token?: string; chat_id?: string };
    if (!config.bot_token || !config.chat_id) continue;
    await sendIncidentStorm(config.bot_token, config.chat_id, alertCount, titles, alertId);
  }
}

// ── Deploy follow-up (15-minute health check) ───────────────────────────────

export async function sendDeployFollowUp(
  botToken: string,
  chatId: string,
  healthy: boolean,
  errorCount: number,
  replyTo?: number
): Promise<void> {
  const text = fmt.formatDeployFollowUp(healthy, errorCount);
  await sendMessage(botToken, chatId, text, { reply_to_message_id: replyTo });
}

// ── Shadow replay result ─────────────────────────────────────────────────────

export async function sendShadowReplay(
  botToken: string,
  chatId: string,
  replay: { totalRecordings: number; passed: number; failed: number; riskScore: number; riskLevel: string },
  replyTo?: number
): Promise<void> {
  await sendMessage(botToken, chatId, fmt.formatShadowReplay(replay), { reply_to_message_id: replyTo });
}

// ── PR prediction ────────────────────────────────────────────────────────────

export async function sendPRPrediction(
  botToken: string,
  chatId: string,
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prediction: string
): Promise<void> {
  const text = fmt.formatPRPrediction(owner, repo, prNumber, prTitle, prediction);
  await sendMessage(botToken, chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "View PR", url: `https://github.com/${owner}/${repo}/pull/${prNumber}` },
      ]],
    },
  });
}

// ── EAP verification ─────────────────────────────────────────────────────────

export async function sendEAPVerification(
  botToken: string,
  chatId: string,
  eap: { verified: boolean; chainDepth: number; surfaces: { httpEndpoints: string[]; dbTables: string[]; llmCalls: { provider: string; model: string }[] } },
  replyTo?: number
): Promise<void> {
  await sendMessage(botToken, chatId, fmt.formatEAPVerification(eap), { reply_to_message_id: replyTo });
}

// ── Get message ID for alert thread context ──────────────────────────────────

export async function getAlertMessageId(chatId: string, alertId: string): Promise<number | undefined> {
  const [link] = await db.select({ messageId: telegramMessageLinks.messageId })
    .from(telegramMessageLinks)
    .where(and(eq(telegramMessageLinks.chatId, chatId), eq(telegramMessageLinks.alertId, alertId)))
    .limit(1);
  return link?.messageId;
}

// ── Weekly digest ────────────────────────────────────────────────────────────

export async function sendWeeklyDigest(
  botToken: string,
  chatId: string,
  stats: { total: number; critical: number; resolved: number; open: number },
  topAlerts: { title: string; severity: string }[],
  aiSummary?: string
): Promise<void> {
  let text = `<b>📊 Weekly InariWatch Digest</b>\n\nTotal: ${stats.total} · Critical: ${stats.critical} · Resolved: ${stats.resolved} · Open: ${stats.open}`;

  if (topAlerts.length > 0) {
    const lines = topAlerts.slice(0, 5).map((a) => {
      const emoji = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟠" : "🔵";
      return `${emoji} ${fmt.esc(a.title.slice(0, 60))}`;
    }).join("\n");
    text += `\n\n<b>Top alerts:</b>\n${lines}`;
  }

  if (aiSummary) text += `\n\n<b>AI Summary:</b>\n${fmt.esc(aiSummary.slice(0, 2000))}`;

  await sendMessage(botToken, chatId, text);
}
