/**
 * Telegram HTML formatting helpers.
 * Telegram uses HTML (not Slack mrkdwn): <b>, <i>, <code>, <pre>, <a>.
 */

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SEV_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🟠",
  info: "🔵",
};

export function formatAlertSummary(
  alerts: { id: string; title: string; severity: string; createdAt: Date; isResolved: boolean }[]
): string {
  if (alerts.length === 0) return "✅ No unresolved alerts!";

  const lines = alerts.map((a) => {
    const emoji = SEV_EMOJI[a.severity] || "⚪";
    const status = a.isResolved ? " (resolved)" : "";
    return `${emoji} <b>${esc(a.title.slice(0, 80))}</b>${status}\n   <code>${a.id.slice(0, 8)}</code> · /fix_${a.id.slice(0, 8)}`;
  });

  return `<b>${alerts.length} alerts:</b>\n\n${lines.join("\n\n")}`;
}

export function formatStatus(
  alertCount: number,
  criticalCount: number,
  onCallUser: string | null
): string {
  return [
    `<b>📊 Status</b>`,
    `Open alerts: <b>${alertCount}</b>`,
    `Critical: <b>${criticalCount}</b>`,
    onCallUser ? `On-call: <b>${esc(onCallUser)}</b>` : "On-call: not configured",
  ].join("\n");
}

export function formatTrends(
  days: number,
  current: number,
  previous: number,
  topErrors: { title: string; count: number; severity: string }[]
): string {
  const change = previous > 0
    ? `${current > previous ? "+" : ""}${Math.round(((current - previous) / previous) * 100)}%`
    : "N/A";

  let text = `<b>📈 Error Trends — Last ${days} Days</b>\n\nTotal: <b>${current}</b> (${change} vs previous)\n`;

  if (topErrors.length > 0) {
    text += "\n<b>Top recurring:</b>\n";
    for (const e of topErrors.slice(0, 5)) {
      text += `${SEV_EMOJI[e.severity] || "⚪"} ${esc(e.title.slice(0, 60))} — ${e.count}x\n`;
    }
  }

  return text;
}

export function formatUptime(
  monitors: { projectName: string; url: string; isDown: boolean; statusCode?: number | null; responseTimeMs?: number | null }[]
): string {
  if (monitors.length === 0) return "No uptime monitors configured.";

  const allUp = monitors.every((m) => !m.isDown);
  let text = allUp ? "<b>✅ All Systems Operational</b>\n\n" : "<b>⚠️ Degraded</b>\n\n";

  for (const m of monitors) {
    const status = m.isDown ? "🔴" : "🟢";
    const details = m.statusCode ? `HTTP ${m.statusCode} · ${m.responseTimeMs ?? "?"}ms` : "no data";
    text += `${status} <b>${esc(m.projectName)}</b> — ${esc(m.url)}\n   ${details}\n`;
  }

  return text;
}

export function formatOnCall(
  rotations: { projectName: string; userName: string | null; level: number }[]
): string {
  if (rotations.length === 0) return "No on-call schedules configured.";

  let text = "<b>📟 On-Call Rotation</b>\n\n";
  for (const r of rotations) {
    const level = r.level === 1 ? "Primary" : "Secondary";
    text += `<b>${esc(r.projectName)}</b> · ${level}: ${r.userName ? esc(r.userName) : "unassigned"}\n`;
  }
  return text;
}

export function formatCommunityFixes(
  query: string,
  results: { patternText: string; category: string; fixes: { approach: string; successPct: number; total: number }[] }[]
): string {
  if (results.length === 0) return `No community fixes found for: <i>${esc(query)}</i>`;

  let text = `<b>🔍 Community Fixes</b>\n\n`;
  for (const r of results.slice(0, 3)) {
    text += `<b>${esc(r.patternText.slice(0, 80))}</b>\n<i>${r.category}</i>\n`;
    for (const f of r.fixes.slice(0, 2)) {
      text += `   • ${esc(f.approach)} — ${f.successPct}% success (${f.total} teams)\n`;
    }
    text += "\n";
  }
  return text;
}

export function formatHelp(): string {
  return [
    "<b>InariWatch Bot Commands</b>\n",
    "/status — Open alerts + on-call",
    "/alerts [critical|warning|info] — List alerts",
    "/fix_ALERTID — Trigger AI remediation",
    "/oncall — On-call rotation",
    "/trends [days] — Error trends",
    "/ask QUESTION — Ask Inari AI",
    "/uptime — Monitor status",
    "/rollback PROJECT — Rollback Vercel",
    "/maintenance PROJECT MINS — Maintenance window",
    "/search ERROR — Community fixes",
    "/integrations — Health check",
    "/link EMAIL — Link your account",
    "/help — This message",
  ].join("\n");
}
