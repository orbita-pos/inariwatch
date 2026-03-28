import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack/verify";
import { resolveSlackUser } from "@/lib/slack/actions";
import { db, slackInstallations, alerts, onCallSchedules } from "@/lib/db";
import { eq, desc, inArray, and } from "drizzle-orm";
import { getUserProjectIds } from "@/lib/db";
import { getCurrentOnCallUserId } from "@/lib/on-call";
import {
  buildStatusBlocks,
  buildOnCallBlocks,
  buildHelpBlocks,
} from "@/lib/slack/blocks";
import { rateLimit } from "@/lib/auth-rate-limit";
import { runSlackRemediation } from "@/lib/slack/remediation-bridge";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { valid, body } = await verifySlackRequest(req);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const params = new URLSearchParams(body);
  const commandText = (params.get("text") || "").trim();
  const slackUserId = params.get("user_id") || "";
  const teamId = params.get("team_id") || "";
  const responseUrl = params.get("response_url") || "";

  // Look up installation
  const [install] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);
  if (!install) {
    return NextResponse.json({ response_type: "ephemeral", text: "Workspace not connected to InariWatch." });
  }

  // Parse subcommand early — link command works before user resolution
  const [subcommand, ...args] = commandText.split(/\s+/);

  // Handle link command (works for unlinked users)
  if (subcommand?.toLowerCase() === "link") {
    return handleLink(slackUserId, install.id, args[0]);
  }

  // Resolve user
  const userId = await resolveSlackUser(slackUserId, install.id);
  if (!userId) {
    const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://app.inariwatch.com";
    return NextResponse.json({
      response_type: "ephemeral",
      text: `Your Slack account is not linked. Run \`/inariwatch link <your-email>\` to connect, or visit ${appUrl}/settings.`,
    });
  }

  // Rate limit
  const rl = await rateLimit("slack-command", userId, { windowMs: 60_000, max: 10 });
  if (!rl.allowed) {
    return NextResponse.json({ response_type: "ephemeral", text: "Rate limited. Try again shortly." });
  }

  switch (subcommand?.toLowerCase() || "help") {
    case "status":
      return handleStatus(userId);

    case "alerts":
      return handleAlerts(userId);

    case "fix":
      return handleFix(args[0], userId, responseUrl);

    case "oncall":
      return handleOnCall(userId, args);

    case "help":
    default:
      return NextResponse.json({ response_type: "ephemeral", blocks: buildHelpBlocks() });
  }
}

async function handleStatus(userId: string) {
  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return NextResponse.json({ response_type: "ephemeral", text: "No projects found." });
  }

  const openAlerts = await db
    .select({ id: alerts.id, severity: alerts.severity })
    .from(alerts)
    .where(and(inArray(alerts.projectId, projectIds), eq(alerts.isResolved, false)))
    .limit(200);

  const critical = openAlerts.filter((a) => a.severity === "critical").length;

  // Get first project's on-call
  let onCallName: string | null = null;
  const onCallUserId = await getCurrentOnCallUserId(projectIds[0]);
  if (onCallUserId) {
    const { users } = await import("@/lib/db");
    const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, onCallUserId)).limit(1);
    onCallName = user?.name ?? null;
  }

  const blocks = buildStatusBlocks(openAlerts.length, critical, onCallName);
  return NextResponse.json({ response_type: "in_channel", blocks });
}

async function handleAlerts(userId: string) {
  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return NextResponse.json({ response_type: "ephemeral", text: "No projects found." });
  }

  const recentAlerts = await db
    .select()
    .from(alerts)
    .where(and(inArray(alerts.projectId, projectIds), eq(alerts.isResolved, false)))
    .orderBy(desc(alerts.createdAt))
    .limit(10);

  if (recentAlerts.length === 0) {
    return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: No unresolved alerts!" });
  }

  const EMOJI: Record<string, string> = { critical: ":red_circle:", warning: ":large_orange_circle:", info: ":large_blue_circle:" };
  const lines = recentAlerts.map((a) => {
    const emoji = EMOJI[a.severity] || ":white_circle:";
    const ago = timeAgo(a.createdAt);
    return `${emoji} *${a.title?.slice(0, 80)}* (${ago})\n   \`${a.id.slice(0, 8)}\` — /inariwatch fix ${a.id.slice(0, 8)}`;
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `*${recentAlerts.length} unresolved alerts:*\n\n${lines.join("\n\n")}`,
  });
}

async function handleFix(alertIdPrefix: string | undefined, userId: string, responseUrl: string) {
  if (!alertIdPrefix) {
    return NextResponse.json({ response_type: "ephemeral", text: "Usage: `/inariwatch fix <alert-id>`" });
  }

  // Find alert by ID prefix
  const projectIds = await getUserProjectIds(userId);
  const allAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(inArray(alerts.projectId, projectIds))
    .limit(200);

  const match = allAlerts.find((a) => a.id.startsWith(alertIdPrefix));
  if (!match) {
    return NextResponse.json({ response_type: "ephemeral", text: `No alert found matching \`${alertIdPrefix}\`` });
  }

  waitUntil(runSlackRemediation(match.id, userId, responseUrl));
  return NextResponse.json({ response_type: "ephemeral", text: `:gear: Starting remediation for \`${match.id.slice(0, 8)}\`...` });
}

async function handleOnCall(userId: string, args: string[]) {
  const projectIds = await getUserProjectIds(userId);
  if (projectIds.length === 0) {
    return NextResponse.json({ response_type: "ephemeral", text: "No projects found." });
  }

  // Handle swap: /inariwatch oncall swap @user
  if (args[0] === "swap" && args[1]) {
    return handleOnCallSwap(userId, args[1], projectIds);
  }

  const { users, projects } = await import("@/lib/db");
  const rotations: { projectName: string; userName: string | null; level: number }[] = [];

  for (const pid of projectIds.slice(0, 10)) {
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, pid)).limit(1);
    const onCallUserId = await getCurrentOnCallUserId(pid);
    let userName: string | null = null;
    if (onCallUserId) {
      const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, onCallUserId)).limit(1);
      userName = user?.name ?? null;
    }
    rotations.push({ projectName: project?.name ?? "Unknown", userName, level: 1 });
  }

  const blocks = buildOnCallBlocks(rotations);
  return NextResponse.json({ response_type: "in_channel", blocks });
}

async function handleOnCallSwap(userId: string, slackMention: string, projectIds: string[]) {
  // Parse Slack mention: <@U12345> → U12345
  const match = slackMention.match(/<@([A-Z0-9]+)>/);
  if (!match) {
    return NextResponse.json({ response_type: "ephemeral", text: "Usage: `/inariwatch oncall swap @user`" });
  }

  const targetSlackUserId = match[1];

  // Resolve target Slack user to InariWatch user
  const { slackUserLinks, slackInstallations, onCallOverrides, onCallSchedules } = await import("@/lib/db");
  const [targetLink] = await db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.slackUserId, targetSlackUserId))
    .limit(1);

  if (!targetLink) {
    return NextResponse.json({ response_type: "ephemeral", text: "That user is not linked to InariWatch." });
  }

  // Find first project with an on-call schedule
  for (const pid of projectIds) {
    const [schedule] = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.projectId, pid))
      .limit(1);

    if (schedule) {
      // Create a 24-hour override for the target user
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await db.insert(onCallOverrides).values({
        scheduleId: schedule.id,
        userId: targetLink.userId,
        level: 1,
        startsAt: now,
        endsAt: tomorrow,
      });

      return NextResponse.json({
        response_type: "in_channel",
        text: `:arrows_counterclockwise: On-call swap: <@${targetSlackUserId}> is now on-call for the next 24 hours.`,
      });
    }
  }

  return NextResponse.json({ response_type: "ephemeral", text: "No on-call schedules found for your projects." });
}

async function handleLink(slackUserId: string, installationId: string, email: string | undefined) {
  if (!email) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Usage: `/inariwatch link your@email.com`\nUse the email you registered with on InariWatch.",
    });
  }

  const { users, slackUserLinks } = await import("@/lib/db");

  // Find InariWatch user by email
  const [user] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: `No InariWatch account found for \`${email}\`. Check the email or sign up first.`,
    });
  }

  // Check if already linked
  const existing = await db
    .select()
    .from(slackUserLinks)
    .where(and(
      eq(slackUserLinks.slackUserId, slackUserId),
      eq(slackUserLinks.installationId, installationId),
    ))
    .limit(1);

  if (existing.length > 0) {
    return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: Already linked!" });
  }

  // Create link
  await db.insert(slackUserLinks).values({
    userId: user.id,
    installationId,
    slackUserId,
  });

  return NextResponse.json({
    response_type: "ephemeral",
    text: `:link: Linked! Your Slack account is now connected to *${user.name || email}* on InariWatch.`,
  });
}

function timeAgo(date: Date | null): string {
  if (!date) return "unknown";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
