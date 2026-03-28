import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack/verify";
import { resolveSlackUser } from "@/lib/slack/actions";
import { getSlackClient } from "@/lib/slack/client";
import { db, slackInstallations, slackMessageThreads, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { rateLimit } from "@/lib/auth-rate-limit";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { valid, body } = await verifySlackRequest(req);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // URL verification challenge (Slack app setup)
  if (event.type === "url_verification") {
    return NextResponse.json({ challenge: event.challenge });
  }

  // Event callback
  if (event.type === "event_callback") {
    const ev = event.event as Record<string, unknown> | undefined;
    const teamId = event.team_id as string;

    if (ev && (ev.type === "app_mention" || (ev.type === "message" && ev.channel_type === "im"))) {
      // Don't respond to bot's own messages
      if (ev.bot_id || ev.subtype === "bot_message") {
        return NextResponse.json({ ok: true });
      }

      waitUntil(handleAIChat(teamId, ev as { user: string; text: string; channel: string; thread_ts?: string; ts: string }));
    }
  }

  return NextResponse.json({ ok: true });
}

async function handleAIChat(
  teamId: string,
  ev: { user: string; text: string; channel: string; thread_ts?: string; ts: string },
) {
  try {
    // Look up installation
    const [install] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);
    if (!install) return;

    // Resolve user
    const userId = await resolveSlackUser(ev.user, install.id);
    if (!userId) {
      const client = await getSlackClient(install.id);
      await client.chat.postMessage({
        channel: ev.channel,
        thread_ts: ev.thread_ts || ev.ts,
        text: "Your Slack account is not linked to InariWatch. Ask your admin to set up user linking.",
      });
      return;
    }

    // Rate limit AI calls
    const rl = await rateLimit("slack-ai", userId, { windowMs: 60_000, max: 5 });
    if (!rl.allowed) {
      const client = await getSlackClient(install.id);
      await client.chat.postMessage({
        channel: ev.channel,
        thread_ts: ev.thread_ts || ev.ts,
        text: "You're sending too many messages. Please wait a moment.",
      });
      return;
    }

    // Clean the mention from the text
    const question = ev.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!question) return;

    // Check if this is in an alert thread — add context
    let alertContext = "";
    if (ev.thread_ts) {
      const [thread] = await db
        .select()
        .from(slackMessageThreads)
        .where(eq(slackMessageThreads.threadTs, ev.thread_ts))
        .limit(1);

      if (thread?.alertId) {
        const [alert] = await db
          .select()
          .from(alerts)
          .where(eq(alerts.id, thread.alertId))
          .limit(1);

        if (alert) {
          alertContext = `\n\n[CURRENT ALERT CONTEXT]\nTitle: ${alert.title}\nSeverity: ${alert.severity}\nBody: ${alert.body?.slice(0, 1000)}\nAI Reasoning: ${alert.aiReasoning || "None"}\nResolved: ${alert.isResolved}`;
        }
      }
    }

    // Call AI (non-streaming)
    const { callAI } = await import("@/lib/ai/client");
    const { getUserProjectIds } = await import("@/lib/db");
    const { db: database, alerts: alertsTable } = await import("@/lib/db");
    const { desc, inArray } = await import("drizzle-orm");

    const projectIds = await getUserProjectIds(userId);
    let dataContext = "";
    if (projectIds.length > 0) {
      const recentAlerts = await database
        .select({ title: alertsTable.title, severity: alertsTable.severity, isResolved: alertsTable.isResolved, createdAt: alertsTable.createdAt })
        .from(alertsTable)
        .where(inArray(alertsTable.projectId, projectIds))
        .orderBy(desc(alertsTable.createdAt))
        .limit(20);

      dataContext = `\n\n[RECENT ALERTS]\n${recentAlerts.map((a) => `- [${a.severity}] ${a.title} (${a.isResolved ? "resolved" : "open"}, ${a.createdAt?.toISOString()})`).join("\n")}`;
    }

    const systemPrompt = `You are Inari AI, an ops copilot for a developer monitoring platform called InariWatch.
Answer questions about the user's systems based on the data below.
Rules:
1. Be concise and specific — use actual data, not generic advice.
2. When referencing alerts, include severity, title, and date.
3. If the data doesn't contain enough info to answer, say so honestly.
4. Format responses in Slack mrkdwn (use *bold*, _italic_, \`code\`).
5. Never invent alerts or incidents that aren't in the data.
6. Keep responses under 300 words.${dataContext}${alertContext}`;

    // Get user's AI key
    const { apiKeys } = await import("@/lib/db");
    const [aiKey] = await database
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .limit(1);

    let response: string;
    if (aiKey?.keyEncrypted) {
      const { decrypt } = await import("@/lib/crypto");
      const key = decrypt(aiKey.keyEncrypted);
      const { detectProvider } = await import("@/lib/ai/client");
      const provider = ((aiKey.metadata as Record<string, string>)?.provider as import("@/lib/ai/client").AIProvider) || detectProvider(key);
      response = await callAI(key, systemPrompt, [{ role: "user", content: question }], {
        maxTokens: 500,
        timeout: 30000,
        provider,
      });
    } else {
      response = "No AI key configured. Add your API key in InariWatch Settings → AI Keys.";
    }

    // Post response
    const client = await getSlackClient(install.id);
    await client.chat.postMessage({
      channel: ev.channel,
      thread_ts: ev.thread_ts || ev.ts,
      text: response,
    });
  } catch (err) {
    console.error("[slack/events] AI chat error:", err);
  }
}
