import { NextRequest, NextResponse } from "next/server";
import { db, users, telegramUserLinks, notificationChannels, alerts, projects, uptimeMonitors, uptimeChecks, projectIntegrations, maintenanceWindows, remediationSessions } from "@/lib/db";
import { eq, and, desc, inArray, gt } from "drizzle-orm";
import { sendMessage, answerCallbackQuery } from "@/lib/telegram/bot";
import * as fmt from "@/lib/telegram/format";
import { rateLimit } from "@/lib/auth-rate-limit";
import { queryAlerts, getErrorTrends, silenceAlert, acknowledgeAlert, reopenAlert } from "@/lib/services/alerts.service";
import { rollbackToDeployment } from "@/lib/services/vercel.service";
import { gatherChatContext, buildContextString, SYSTEM_OPS } from "@/lib/services/chat.service";
import { getCurrentOnCallUserId } from "@/lib/on-call";

export const runtime = "nodejs";

// Verify Telegram webhook secret
function verifySecret(req: NextRequest): boolean {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  return secret === process.env.TELEGRAM_WEBHOOK_SECRET;
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) return new Response("Unauthorized", { status: 401 });

  const update = await req.json();

  // Handle callback queries (button presses)
  if (update.callback_query) {
    return handleCallback(update.callback_query);
  }

  // Handle messages (commands)
  const message = update.message;
  if (!message?.text) return NextResponse.json({ ok: true });

  const chatId = String(message.chat.id);
  const tgUserId = String(message.from.id);
  const text = message.text.trim();

  // Find the bot token for this chat
  const botToken = await findBotToken(chatId);
  if (!botToken) return NextResponse.json({ ok: true });

  // Parse command
  const match = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)/);
  if (!match) return NextResponse.json({ ok: true });

  const [, command, argsStr] = match;
  const args = argsStr.trim().split(/\s+/).filter(Boolean);

  // Handle /link before user resolution
  if (command === "link") {
    return handleLink(botToken, chatId, tgUserId, args[0]);
  }

  if (command === "start" || command === "help") {
    await sendMessage(botToken, chatId, fmt.formatHelp());
    return NextResponse.json({ ok: true });
  }

  // Resolve Telegram user → InariWatch user
  const userId = await resolveUser(tgUserId);
  if (!userId) {
    await sendMessage(botToken, chatId, "Your Telegram is not linked. Use /link your@email.com");
    return NextResponse.json({ ok: true });
  }

  // Rate limit
  const rl = await rateLimit("telegram-cmd", userId, { windowMs: 60_000, max: 15 });
  if (!rl.allowed) {
    await sendMessage(botToken, chatId, "Rate limited. Try again shortly.");
    return NextResponse.json({ ok: true });
  }

  // Get user's project IDs
  const { getUserProjectIds } = await import("@/lib/db");
  const projectIds = await getUserProjectIds(userId);

  switch (command) {
    case "status":
      await cmdStatus(botToken, chatId, userId, projectIds);
      break;
    case "alerts":
      await cmdAlerts(botToken, chatId, projectIds, args);
      break;
    case "trends":
      await cmdTrends(botToken, chatId, projectIds, args[0]);
      break;
    case "uptime":
      await cmdUptime(botToken, chatId, projectIds);
      break;
    case "oncall":
      await cmdOnCall(botToken, chatId, projectIds);
      break;
    case "ask":
      await cmdAsk(botToken, chatId, userId, projectIds, argsStr.trim());
      break;
    case "rollback":
      await cmdRollback(botToken, chatId, userId, projectIds, args[0]);
      break;
    case "maintenance":
      await cmdMaintenance(botToken, chatId, userId, projectIds, args[0], args[1]);
      break;
    case "search":
      await cmdSearch(botToken, chatId, argsStr.trim());
      break;
    case "integrations":
      await cmdIntegrations(botToken, chatId, projectIds);
      break;
    default:
      // Handle /fix_ALERTID pattern
      if (command?.startsWith("fix_")) {
        await cmdFix(botToken, chatId, userId, command.slice(4));
      } else {
        await sendMessage(botToken, chatId, fmt.formatHelp());
      }
  }

  return NextResponse.json({ ok: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findBotToken(chatId: string): Promise<string | null> {
  const [ch] = await db
    .select({ config: notificationChannels.config })
    .from(notificationChannels)
    .where(eq(notificationChannels.type, "telegram"))
    .limit(50);

  // Search all telegram channels for matching chat_id
  const channels = await db
    .select({ config: notificationChannels.config })
    .from(notificationChannels)
    .where(eq(notificationChannels.type, "telegram"));

  for (const c of channels) {
    const cfg = c.config as { bot_token?: string; chat_id?: string };
    if (cfg.chat_id === chatId && cfg.bot_token) return cfg.bot_token;
  }
  return null;
}

async function resolveUser(tgUserId: string): Promise<string | null> {
  const [link] = await db
    .select({ userId: telegramUserLinks.userId })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramUserId, tgUserId))
    .limit(1);
  return link?.userId ?? null;
}

function inlineKeyboard(buttons: { text: string; callback_data: string }[][]) {
  return { inline_keyboard: buttons };
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function handleLink(botToken: string, chatId: string, tgUserId: string, email?: string) {
  if (!email) {
    await sendMessage(botToken, chatId, "Usage: /link your@email.com");
    return NextResponse.json({ ok: true });
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) {
    await sendMessage(botToken, chatId, `No InariWatch account found for ${fmt.esc(email)}.`);
    return NextResponse.json({ ok: true });
  }

  // Check if already linked
  const [existing] = await db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.telegramUserId, tgUserId))
    .limit(1);

  if (existing) {
    await sendMessage(botToken, chatId, "✅ Already linked!");
    return NextResponse.json({ ok: true });
  }

  await db.insert(telegramUserLinks).values({
    userId: user.id,
    telegramUserId: tgUserId,
    chatId,
    botToken,
  });

  await sendMessage(botToken, chatId, `🔗 Linked! Connected to <b>${fmt.esc(user.name || email)}</b> on InariWatch.`);
  return NextResponse.json({ ok: true });
}

async function cmdStatus(botToken: string, chatId: string, userId: string, projectIds: string[]) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  const allAlerts = await queryAlerts({ projectIds, isResolved: false, limit: 100 });
  const criticalCount = allAlerts.filter((a) => a.severity === "critical").length;

  // Get on-call for first project
  let onCallUser: string | null = null;
  const onCallUserId = await getCurrentOnCallUserId(projectIds[0], 1);
  if (onCallUserId) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, onCallUserId)).limit(1);
    onCallUser = u?.name ?? null;
  }

  await sendMessage(botToken, chatId, fmt.formatStatus(allAlerts.length, criticalCount, onCallUser));
}

async function cmdAlerts(botToken: string, chatId: string, projectIds: string[], args: string[]) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  let severity: "critical" | "warning" | "info" | undefined;
  const valid = ["critical", "warning", "info"];
  for (const a of args) { if (valid.includes(a)) severity = a as typeof severity; }

  const result = await queryAlerts({ projectIds, severity, isResolved: false, limit: 10 });

  const text = fmt.formatAlertSummary(result);
  const buttons = result.slice(0, 5).map((a) => ([
    { text: "👁️ Ack", callback_data: `ack:${a.id}` },
    { text: "✅ Resolve", callback_data: `resolve:${a.id}` },
    { text: "🔧 Fix", callback_data: `fix:${a.id}` },
  ]));

  await sendMessage(botToken, chatId, text, { reply_markup: buttons.length > 0 ? inlineKeyboard(buttons) : undefined });
}

async function cmdTrends(botToken: string, chatId: string, projectIds: string[], daysArg?: string) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }
  const days = Math.min(Number(daysArg) || 7, 30);
  const trends = await getErrorTrends(projectIds, days);
  await sendMessage(botToken, chatId, fmt.formatTrends(days, trends.current, trends.previous, trends.topErrors));
}

async function cmdUptime(botToken: string, chatId: string, projectIds: string[]) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  const userProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds));
  const projectMap = new Map(userProjects.map((p) => [p.id, p.name]));

  const monitors = await db.select().from(uptimeMonitors).where(and(inArray(uptimeMonitors.projectId, projectIds), eq(uptimeMonitors.isActive, true)));

  const data = await Promise.all(monitors.map(async (m) => {
    const [check] = await db.select({ statusCode: uptimeChecks.statusCode, responseTimeMs: uptimeChecks.responseTimeMs })
      .from(uptimeChecks).where(eq(uptimeChecks.monitorId, m.id)).orderBy(desc(uptimeChecks.checkedAt)).limit(1);
    return {
      projectName: projectMap.get(m.projectId) ?? "?",
      url: m.url, isDown: m.isDown,
      statusCode: check?.statusCode, responseTimeMs: check?.responseTimeMs,
    };
  }));

  await sendMessage(botToken, chatId, fmt.formatUptime(data));
}

async function cmdOnCall(botToken: string, chatId: string, projectIds: string[]) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  const userProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds));
  const rotations: { projectName: string; userName: string | null; level: number }[] = [];

  for (const p of userProjects) {
    const uid = await getCurrentOnCallUserId(p.id, 1);
    let userName: string | null = null;
    if (uid) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, uid)).limit(1);
      userName = u?.name ?? null;
    }
    rotations.push({ projectName: p.name, userName, level: 1 });
  }

  await sendMessage(botToken, chatId, fmt.formatOnCall(rotations));
}

async function cmdAsk(botToken: string, chatId: string, userId: string, projectIds: string[], question: string) {
  if (!question) { await sendMessage(botToken, chatId, "Usage: /ask what broke yesterday?"); return; }
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  await sendMessage(botToken, chatId, "🧠 Thinking...");

  try {
    const { getUserAIKey } = await import("@/lib/ai/get-key");
    const aiKey = await getUserAIKey(userId);
    if (!aiKey) { await sendMessage(botToken, chatId, "No AI key configured. Add one in Settings → AI."); return; }

    const ctx = await gatherChatContext(projectIds);
    const context = buildContextString(ctx);

    const { callAI } = await import("@/lib/ai/client");
    const result = await callAI(aiKey.key, SYSTEM_OPS, [
      { role: "user", content: `${context}\n\n---\n\nUser question: ${question}` },
    ]);

    await sendMessage(botToken, chatId, result.slice(0, 4096));
  } catch (e) {
    await sendMessage(botToken, chatId, `Error: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

async function cmdRollback(botToken: string, chatId: string, userId: string, projectIds: string[], projectSlug?: string) {
  if (!projectSlug) { await sendMessage(botToken, chatId, "Usage: /rollback project-slug"); return; }

  const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug)).limit(1);
  if (!project || !projectIds.includes(project.id)) { await sendMessage(botToken, chatId, `Project not found: ${fmt.esc(projectSlug)}`); return; }

  try {
    const result = await rollbackToDeployment(project.id);
    await sendMessage(botToken, chatId, `✅ <b>Rollback complete</b>\nProject: ${fmt.esc(project.name)}\nDeployment: <code>${result.uid.slice(0, 12)}</code>${result.url ? `\nURL: ${result.url}` : ""}`);
  } catch (e) {
    await sendMessage(botToken, chatId, `❌ Rollback failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

async function cmdMaintenance(botToken: string, chatId: string, userId: string, projectIds: string[], projectSlug?: string, minsArg?: string) {
  if (!projectSlug) { await sendMessage(botToken, chatId, "Usage: /maintenance project-slug 30"); return; }

  const [project] = await db.select().from(projects).where(eq(projects.slug, projectSlug)).limit(1);
  if (!project || !projectIds.includes(project.id)) { await sendMessage(botToken, chatId, `Project not found: ${fmt.esc(projectSlug)}`); return; }

  const mins = Math.min(Math.max(Number(minsArg) || 30, 5), 1440);
  const endsAt = new Date(Date.now() + mins * 60_000);

  await db.insert(maintenanceWindows).values({
    projectId: project.id,
    title: "Maintenance (Telegram)",
    startsAt: new Date(),
    endsAt,
    createdBy: userId,
  });

  await sendMessage(botToken, chatId, `🔧 <b>Maintenance active</b>\nProject: ${fmt.esc(project.name)}\nDuration: ${mins} minutes\nEnds: ${endsAt.toISOString().slice(0, 16)}`);
}

async function cmdSearch(botToken: string, chatId: string, query: string) {
  if (!query) { await sendMessage(botToken, chatId, "Usage: /search TypeError cannot read property"); return; }

  const { sql: sqlTag } = await import("drizzle-orm");
  const raw = await db.execute(sqlTag`
    SELECT p.pattern_text, p.category, cf.fix_approach, cf.success_count, cf.total_applications
    FROM error_patterns p LEFT JOIN community_fixes cf ON cf.pattern_id = p.id
    WHERE similarity(p.pattern_text, ${query}) > 0.1
    ORDER BY similarity(p.pattern_text, ${query}) DESC, cf.success_count DESC LIMIT 15
  `);

  const rows = raw.rows as { pattern_text: string; category: string; fix_approach: string | null; success_count: number | null; total_applications: number | null }[];
  const patterns = new Map<string, { patternText: string; category: string; fixes: { approach: string; successPct: number; total: number }[] }>();
  for (const r of rows) {
    if (!patterns.has(r.pattern_text)) patterns.set(r.pattern_text, { patternText: r.pattern_text, category: r.category, fixes: [] });
    if (r.fix_approach) {
      const total = Number(r.total_applications) || 0;
      const success = Number(r.success_count) || 0;
      patterns.get(r.pattern_text)!.fixes.push({ approach: r.fix_approach, successPct: total > 0 ? Math.round((success / total) * 100) : 0, total });
    }
  }

  await sendMessage(botToken, chatId, fmt.formatCommunityFixes(query, Array.from(patterns.values())));
}

async function cmdIntegrations(botToken: string, chatId: string, projectIds: string[]) {
  if (projectIds.length === 0) { await sendMessage(botToken, chatId, "No projects found."); return; }

  const userProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds));
  const integrations = await db.select().from(projectIntegrations).where(inArray(projectIntegrations.projectId, projectIds));
  const projectMap = new Map(userProjects.map((p) => [p.id, p.name]));

  if (integrations.length === 0) { await sendMessage(botToken, chatId, "No integrations connected."); return; }

  const lines = integrations.map((i) => {
    const status = i.isActive ? "🟢" : "🔴";
    const errors = i.errorCount > 0 ? ` ⚠️ ${i.errorCount} errors` : "";
    return `${status} <b>${i.service}</b> (${fmt.esc(projectMap.get(i.projectId) ?? "?")})${errors}`;
  }).join("\n");

  await sendMessage(botToken, chatId, `<b>Integration Health</b>\n\n${lines}`);
}

async function cmdFix(botToken: string, chatId: string, userId: string, alertIdPrefix: string) {
  const allAlerts = await db.select({ id: alerts.id, title: alerts.title }).from(alerts).limit(100);
  const alert = allAlerts.find((a) => a.id.startsWith(alertIdPrefix));

  if (!alert) { await sendMessage(botToken, chatId, `Alert not found: ${fmt.esc(alertIdPrefix)}`); return; }

  await sendMessage(botToken, chatId, `🔧 Starting remediation for: <b>${fmt.esc(alert.title)}</b>`);

  try {
    const { runRemediation } = await import("@/lib/ai/remediate");

    const [session] = await db.insert(remediationSessions).values({
      alertId: alert.id,
      projectId: (await db.select({ projectId: alerts.projectId }).from(alerts).where(eq(alerts.id, alert.id)).limit(1))[0]?.projectId ?? "",
      userId,
      status: "analyzing",
      attempt: 1,
      maxAttempts: 3,
      steps: [{ id: "telegram_trigger", type: "info", message: "Remediation triggered via Telegram", status: "completed", timestamp: new Date().toISOString() }],
    }).returning({ id: remediationSessions.id });

    // Fire and forget
    runRemediation(session.id, () => {}).catch(() => {});
    await sendMessage(botToken, chatId, `✅ Remediation started. Session: <code>${session.id.slice(0, 12)}</code>`);
  } catch (e) {
    await sendMessage(botToken, chatId, `❌ Failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
}

// ── Callback query handler (button presses) ─────────────────────────────────

async function handleCallback(query: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number } } }) {
  const data = query.data ?? "";
  const chatId = String(query.message?.chat.id ?? "");
  const tgUserId = String(query.from.id);

  const botToken = await findBotToken(chatId);
  if (!botToken) { return NextResponse.json({ ok: true }); }

  const userId = await resolveUser(tgUserId);
  if (!userId) {
    await answerCallbackQuery(botToken, query.id, "Link your account first: /link email");
    return NextResponse.json({ ok: true });
  }

  const [action, alertId] = data.split(":");

  switch (action) {
    case "ack":
      await acknowledgeAlert(alertId);
      await answerCallbackQuery(botToken, query.id, "👁️ Acknowledged");
      break;
    case "resolve":
      await silenceAlert(alertId, true);
      await answerCallbackQuery(botToken, query.id, "✅ Resolved");
      break;
    case "reopen":
      await reopenAlert(alertId);
      await answerCallbackQuery(botToken, query.id, "🔄 Reopened");
      break;
    case "fix":
      await answerCallbackQuery(botToken, query.id, "🔧 Starting fix...");
      await cmdFix(botToken, chatId, userId, alertId);
      break;
    default:
      await answerCallbackQuery(botToken, query.id);
  }

  return NextResponse.json({ ok: true });
}
