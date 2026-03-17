import { NextResponse } from "next/server";
import {
  db,
  users,
  alerts,
  notificationChannels,
  projects,
} from "@/lib/db";
import { eq, and, gt, desc } from "drizzle-orm";
import { sendEmail } from "@/lib/notifications/email";
import { formatWeeklyDigestEmail } from "@/lib/notifications/digest-email";
import { signValue } from "@/lib/webhooks/shared";
import { getUserAIKey } from "@/lib/ai/get-key";
import { callAI } from "@/lib/ai/client";
import crypto from "crypto";

const CRON_SECRET = process.env.CRON_SECRET;
const APP_URL = process.env.NEXTAUTH_URL ?? "https://inariwatch.com";

export async function GET(req: Request) {
  // Verify secret — same pattern as poll/route.ts
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let sent = 0;

  // Find all users who have at least one active, verified email notification channel
  const emailChannels = await db
    .select({
      id: notificationChannels.id,
      userId: notificationChannels.userId,
      config: notificationChannels.config,
    })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.type, "email"),
        eq(notificationChannels.isActive, true)
      )
    );

  // Filter to only verified channels (verifiedAt is not null)
  const verifiedChannels = [];
  for (const ch of emailChannels) {
    const [full] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, ch.id))
      .limit(1);
    if (full?.verifiedAt) {
      verifiedChannels.push(ch);
    }
  }

  // Group channels by userId (a user might have multiple email channels)
  const userChannelMap = new Map<
    string,
    { channelId: string; email: string }[]
  >();
  for (const ch of verifiedChannels) {
    const config = ch.config as Record<string, string>;
    const email = config.email;
    if (!email) continue;

    const list = userChannelMap.get(ch.userId) ?? [];
    list.push({ channelId: ch.id, email });
    userChannelMap.set(ch.userId, list);
  }

  for (const [userId, channels] of userChannelMap) {
    try {
      // Get all projects owned by this user
      const userProjects = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.userId, userId));

      if (userProjects.length === 0) continue;

      const projectIds = userProjects.map((p) => p.id);

      // Get alerts from the last 7 days across all user projects
      const recentAlerts = [];
      for (const pid of projectIds) {
        const projectAlerts = await db
          .select()
          .from(alerts)
          .where(
            and(eq(alerts.projectId, pid), gt(alerts.createdAt, sevenDaysAgo))
          );
        recentAlerts.push(...projectAlerts);
      }

      // Skip users with no alerts in the last 7 days
      if (recentAlerts.length === 0) continue;

      // Generate AI summary if user has a key
      let aiSummary: string | null = null;
      try {
        const aiKey = await getUserAIKey(userId);
        if (aiKey) {
          const alertList = [...recentAlerts]
            .sort((a, b) => (a.severity === "critical" ? -1 : 1))
            .slice(0, 10)
            .map((a) => `- [${a.severity}] ${a.title}${a.isResolved ? " (resolved)" : ""}`)
            .join("\n");

          aiSummary = await callAI(
            aiKey.key,
            "You are a DevOps assistant writing a concise weekly incident summary for an engineering team. Be professional but conversational. No markdown.",
            [{
              role: "user",
              content: `Summarize this week's monitoring alerts in 2-3 sentences. Highlight patterns, recurring issues, and overall health trend.\n\nAlerts (${recentAlerts.length} total):\n${alertList}`,
            }],
            { maxTokens: 200 }
          );
        }
      } catch {
        // AI summary is optional — proceed without it
      }

      // Compute stats
      const stats = {
        total: recentAlerts.length,
        critical: recentAlerts.filter((a) => a.severity === "critical").length,
        resolved: recentAlerts.filter((a) => a.isResolved).length,
        unresolved: recentAlerts.filter((a) => !a.isResolved).length,
      };

      // Top 5 alerts (most recent, prioritizing critical)
      const topAlerts = [...recentAlerts]
        .sort((a, b) => {
          const severityOrder: Record<string, number> = {
            critical: 0,
            warning: 1,
            info: 2,
          };
          const sa = severityOrder[a.severity] ?? 2;
          const sb = severityOrder[b.severity] ?? 2;
          if (sa !== sb) return sa - sb;
          return (
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        })
        .slice(0, 5)
        .map((a) => ({
          title: a.title,
          severity: a.severity,
          createdAt: a.createdAt,
        }));

      // Send to each email channel for this user
      for (const ch of channels) {
        const unsubToken = signValue(ch.email.toLowerCase());
        const unsubscribeUrl = `${APP_URL}/api/notifications/unsubscribe?email=${encodeURIComponent(ch.email)}&token=${unsubToken}`;
        const html = formatWeeklyDigestEmail(stats, topAlerts, unsubscribeUrl, aiSummary ?? undefined);

        const result = await sendEmail(
          { email: ch.email },
          "Your weekly InariWatch digest",
          html,
          { unsubscribeUrl }
        );

        if (result.ok) sent++;
      }
    } catch {
      // Continue to the next user if one fails
    }
  }

  return NextResponse.json({ ok: true, sent });
}
