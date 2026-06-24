/**
 * Layer 0 resolvers — convert an L0Match into a formatted markdown string
 * by calling the appropriate cloud IPC command.
 *
 * Each resolver is intentionally self-contained: it calls one IPC command,
 * formats the result, and returns a string. Error handling is centralized
 * in `resolveIntent`.
 */

import {
  cloudGetAlerts,
  cloudGetStatusSummary,
  cloudGetUptime,
  cloudGetDeploys,
  cloudGetOncall,
  cloudGetTrends,
  cloudGetRootCause,
  cloudAckAlert,
  cloudSilenceAlert,
  CloudError,
  type DeployRow,
  type OncallScheduleRow,
  type UptimeMonitorRow,
  type TrendDay,
  type TopError,
} from "@/lib/cloud-ipc";
import { useChat } from "@/lib/store/chat";
import type { L0Match } from "./types";

// ── Entry point ───────────────────────────────────────────────────────

export async function resolveIntent(match: L0Match): Promise<string> {
  try {
    switch (match.intent) {
      case "list_alerts":    return await resolveAlerts();
      case "status_summary": return await resolveStatus();
      case "uptime_monitors":return await resolveUptime();
      case "recent_deploys": return await resolveDeploys();
      case "oncall_status":  return await resolveOncall();
      case "help":           return resolveHelp();
      case "open_player":    return resolvePlayer(String(match.params.hash ?? ""));
      case "error_trends":   return await resolveTrends();
      case "root_cause":     return await resolveRootCause();
      case "set_project":    return resolveSetProject(String(match.params.name ?? ""));
      case "ack_alert":      return await resolveAckAlert();
      case "silence_alert":  return await resolveSilenceAlert();
      case "greeting":       return await resolveGreeting();
    }
  } catch (err) {
    if (err instanceof CloudError) {
      if (err.kind === "not_connected") {
        return "_Not connected. Use the Connect button to pair with your InariWatch account._";
      }
      if (err.kind === "unauthorized") {
        return "_Session expired. Please reconnect._";
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `_Couldn't fetch data: ${msg}_`;
  }
}

// ── Formatters ────────────────────────────────────────────────────────

async function resolveAlerts(): Promise<string> {
  const alerts = await cloudGetAlerts(20);

  const active = alerts.filter((a) => !a.isResolved);
  if (active.length === 0) return "**Alerts** — none ✅";

  const critical = active.filter((a) => a.severity === "critical").length;
  const warning  = active.filter((a) => a.severity === "warning").length;

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0)  parts.push(`${warning} warning`);
  const rest = active.length - critical - warning;
  if (rest > 0)     parts.push(`${rest} other`);

  const rows = active.slice(0, 10).map((a) => {
    const age = timeAgo(a.createdAt);
    const title = truncate(a.title, 50);
    return `| ${sevEmoji(a.severity)} | ${title} | ${a.projectName} | ${age} |`;
  });

  return [
    `**Alerts** — ${parts.join(" · ")}`,
    "",
    "| | Title | Project | Age |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

async function resolveStatus(): Promise<string> {
  const s = await cloudGetStatusSummary();

  const stateEmoji =
    s.state === "operational" ? "🟢" :
    s.state === "degraded"    ? "🟡" : "🔴";

  const label = capitalize(s.state);

  if (s.state === "operational") {
    return [
      `**System Status** — ${stateEmoji} ${label}`,
      "",
      `All ${s.monitorsTotal} monitors up · No critical alerts (24h) · ${s.projectCount} projects`,
    ].join("\n");
  }

  return [
    `**System Status** — ${stateEmoji} ${label}`,
    "",
    `Critical (24h): **${s.alertsCritical24h}** · Warning (24h): **${s.alertsWarning24h}** · Monitors down: **${s.monitorsDown}/${s.monitorsTotal}** · Projects: **${s.projectCount}**`,
  ].join("\n");
}

async function resolveUptime(): Promise<string> {
  const { monitors, downCount, avgResponseMs } = await cloudGetUptime();

  if (monitors.length === 0) return "**Uptime** — no monitors configured";

  const avgPart = avgResponseMs != null ? ` · avg ${avgResponseMs}ms` : "";
  const header = `**Uptime** — ${downCount > 0 ? `${downCount} down` : "all up ✅"}${avgPart}`;

  const rows = monitors.slice(0, 12).map((m) => formatMonitorRow(m));

  return [header, "", ...rows].join("\n");
}

function formatMonitorRow(m: UptimeMonitorRow): string {
  const icon = m.isDown ? "🔴" : "🟢";
  const name = m.name ?? m.url;
  if (m.isDown) {
    return `${icon} **${name}** — down (${m.consecutiveFailures} failure${m.consecutiveFailures !== 1 ? "s" : ""})`;
  }
  const ms = m.lastResponseTimeMs != null ? ` — ${m.lastResponseTimeMs}ms` : "";
  return `${icon} ${name}${ms}`;
}

async function resolveDeploys(): Promise<string> {
  const { deploys, failedCount } = await cloudGetDeploys(10);

  if (deploys.length === 0) return "**Deployments** — none recorded";

  const header = failedCount > 0
    ? `**Deployments** — ${failedCount} failed`
    : "**Deployments** — all succeeded ✅";

  const rows = deploys.map((d) => formatDeployRow(d));

  return [header, "", ...rows].join("\n");
}

function formatDeployRow(d: DeployRow): string {
  const icon =
    d.state === "success"  ? "🟢" :
    d.state === "failed"   ? "🔴" :
    d.state === "building" ? "🟡" : "⚪";

  const age   = timeAgo(d.createdAt);
  const title = truncate(d.title, 48);
  return `${icon} **${d.projectName}** · ${title} · ${age}`;
}

async function resolveOncall(): Promise<string> {
  const { schedules } = await cloudGetOncall();

  if (schedules.length === 0) {
    return "**On-Call** — no schedules configured";
  }

  const rows = schedules.map((s) => formatScheduleRow(s));

  return [
    `**On-Call** — ${schedules.length} schedule${schedules.length !== 1 ? "s" : ""}`,
    "",
    "| Project | Primary | Secondary |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

function formatScheduleRow(s: OncallScheduleRow): string {
  const primary   = s.primary?.name   ?? s.primary?.email   ?? "—";
  const secondary = s.secondary?.name ?? s.secondary?.email ?? "—";
  return `| ${s.projectName} | ${primary} | ${secondary} |`;
}

function resolveHelp(): string {
  return [
    "**What I can answer instantly:**",
    "",
    "- `show alerts` · `qué alertas hay` · `cuántos errores`",
    "- `cómo está el sistema` · `system status` · `todo bien?`",
    "- `uptime` · `hay algo caído` · `monitors down`",
    "- `últimos deploys` · `recent deployments` · `qué se deployó`",
    "- `quién está de guardia` · `who is on call`",
    "- `error trends` · `tendencia de errores` · `cuántos errores esta semana`",
    "- `root cause` · `por qué falló` · `diagnóstico` · `qué causó el error`",
    "- `ack` · `got it` · `ya lo vi` · `enterado` — acknowledge most recent alert",
    "- `silence` · `dismiss` · `silencia` · `ya está arreglado` — resolve most recent alert",
    "",
    "**Paste any** `inari:alert:...` **hash to open the incident player.**",
    "**Use** `/project <name>` **to scope queries to one project.**",
    "",
    "For reasoning — _\"why is X failing?\"_, _\"diagnose this\"_ — I use the full AI.",
  ].join("\n");
}

function resolvePlayer(hash: string): string {
  if (!hash) return "_No hash detected._";
  return [
    "Here's the incident:",
    "",
    "```player",
    hash,
    "```",
  ].join("\n");
}

async function resolveTrends(): Promise<string> {
  const project = useChat.getState().activeProjectSlug ?? undefined;
  const t = await cloudGetTrends(7, project);

  const change =
    t.previous > 0
      ? `${t.current > t.previous ? "+" : ""}${Math.round(((t.current - t.previous) / t.previous) * 100)}% vs prev week`
      : "no previous data";

  const dailyRows = buildDailyRows(t.daily);
  const topRows   = t.topErrors.slice(0, 5).map((e: TopError) =>
    `  ${sevEmoji(e.severity)} **${truncate(e.title, 52)}** — ${e.count}×`
  );

  const lines: string[] = [
    `**Error Trends** — last 7 days`,
    "",
    `Total: **${t.current}** alerts (${change})`,
    "",
    "**Daily breakdown:**",
    ...dailyRows,
  ];
  if (topRows.length > 0) {
    lines.push("", "**Top recurring errors:**", ...topRows);
  }
  return lines.join("\n");
}

function buildDailyRows(daily: TrendDay[]): string[] {
  const byDate = new Map<string, Record<string, number>>();
  for (const r of daily) {
    if (!byDate.has(r.date)) byDate.set(r.date, {});
    byDate.get(r.date)![r.severity] = r.count;
  }
  const rows: string[] = [];
  for (const [date, severities] of byDate) {
    const parts = Object.entries(severities)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, c]) => `${sevEmoji(s)} ${c}`);
    rows.push(`  ${date} — ${parts.join("  ")}`);
  }
  return rows;
}

async function resolveRootCause(): Promise<string> {
  const project = useChat.getState().activeProjectSlug ?? undefined;
  const item = await cloudGetRootCause(undefined, project);

  const age   = timeAgo(item.createdAt);
  const sev   = sevEmoji(item.severity);
  const lines: string[] = [
    `**Root Cause** — ${sev} ${item.title}`,
    `_${item.projectName} · ${age} ago_`,
    "",
  ];

  if (item.aiReasoning) {
    lines.push(item.aiReasoning);
  } else {
    lines.push("_No AI analysis available for this alert yet._");
    if (item.body) {
      lines.push("", "**Raw context:**", item.body.slice(0, 600));
    }
  }

  return lines.join("\n");
}

function resolveSetProject(name: string): string {
  if (!name) {
    useChat.getState().setActiveProjectSlug(null);
    return "_Proyecto desactivado. Las consultas ahora agregan todos tus proyectos._";
  }
  useChat.getState().setActiveProjectSlug(name);
  return `**Proyecto activo:** \`${name}\`\n\nLas próximas consultas filtrarán por este proyecto. Escribe \`/project off\` para desactivar.`;
}

async function resolveAckAlert(): Promise<string> {
  const project = useChat.getState().activeProjectSlug ?? undefined;
  const result = await cloudAckAlert(undefined, project);
  if (!result.ok) return "_No active alert to acknowledge._";
  const title = result.title ? `**${truncate(result.title, 60)}**` : "the alert";
  const suffix = project ? ` in \`${project}\`` : "";
  return `✅ Acknowledged ${title}${suffix} — marked as read.`;
}

async function resolveSilenceAlert(): Promise<string> {
  const project = useChat.getState().activeProjectSlug ?? undefined;
  const result = await cloudSilenceAlert(undefined, project);
  if (!result.ok) return "_No active alert to silence._";
  const title = result.title ? `**${truncate(result.title, 60)}**` : "the alert";
  const suffix = project ? ` in \`${project}\`` : "";
  return `🔕 Silenced ${title}${suffix} — marked as resolved.`;
}

/**
 * State-aware greeting resolver. The user typing "hola" / "hey" / "como
 * estas" / "haha" — anything that L0 matches as `greeting` — used to
 * bubble up to the Layer-3 LLM, which under SYSTEM_OPS' scope-enforcement
 * rule returned empty content and left an empty bubble. We now answer
 * deterministically and contextually instead.
 *
 * The response is "what's happening right now" — not a static menu of
 * commands. We fetch alerts + status + deploys in parallel (the three
 * already-existing cloud IPCs Inari Live uses everywhere else, each
 * ~50-150ms; parallel ≈ ~200ms wall) and pick from three templates
 * based on observed severity:
 *
 *   - Critical alerts present → "Tienes N críticas, ¿las miramos?"
 *   - Failed deploys present  → "1 deploy fallando…"
 *   - Everything green        → "Todo tranquilo, ¿qué exploramos?"
 *
 * Each variant ends with 2-3 concrete next-step suggestions written as
 * inline-code queries the user can copy/click — each one matches an L0
 * intent, so the conversation flows fast.
 *
 * If the IPCs fail (not paired, no internet, Tauri unavailable), we
 * fall back to a static greeting with a generic capability summary —
 * the friendly answer never blocks on infrastructure errors.
 */
async function resolveGreeting(): Promise<string> {
  // Parallel fetch — best-effort. Anything that throws becomes a null
  // slot so the template can fall back gracefully. Promise.allSettled
  // keeps a single network blip from killing the whole greeting.
  const [alertsR, statusR, deploysR] = await Promise.allSettled([
    cloudGetAlerts(20),
    cloudGetStatusSummary(),
    cloudGetDeploys(8),
  ]);

  const alerts  = alertsR.status === "fulfilled"  ? alertsR.value  : null;
  const status  = statusR.status === "fulfilled"  ? statusR.value  : null;
  const deploys = deploysR.status === "fulfilled" ? deploysR.value : null;

  // If everything failed we have nothing to anchor on. Static fallback.
  // The user isn't paired with cloud, or the daemon is down. Either way
  // a friendly "hola" is more useful than "_Couldn't fetch data_".
  if (!alerts && !status && !deploys) {
    return [
      "¡Hola! 👋",
      "",
      "No pude leer tu estado ahora mismo (sin conexión o no pareado).",
      "Cuando vuelvas, prueba `qué pasó hoy` o `cómo va el sistema`.",
    ].join("\n");
  }

  const criticalActive = (alerts ?? []).filter(
    (a) => !a.isResolved && a.severity === "critical",
  );
  const warningActive = (alerts ?? []).filter(
    (a) => !a.isResolved && a.severity === "warning",
  );
  const failedDeploys = (deploys?.deploys ?? []).filter(
    (d) => d.state === "failed",
  );

  // Branch 1 — critical alerts present.
  if (criticalActive.length > 0) {
    const oldest = criticalActive[criticalActive.length - 1]!;
    const headline = truncate(oldest.title, 55);
    const ageOldest = timeAgo(oldest.createdAt);
    const lines = [
      "¡Hola! 👋",
      "",
      "Esto es lo que veo ahora:",
      "",
      `🔴 **${criticalActive.length} ${criticalActive.length === 1 ? "crítica" : "críticas"}** sin resolver — la más vieja es _${headline}_ (activa hace ${ageOldest})`,
    ];
    if (warningActive.length > 0) {
      lines.push(`🟡 ${warningActive.length} warning${warningActive.length === 1 ? "" : "s"}`);
    }
    if (failedDeploys.length > 0) {
      lines.push(`🟡 ${failedDeploys.length} deploy${failedDeploys.length === 1 ? "" : "s"} fallando`);
    }
    lines.push(
      "",
      "¿Por dónde le entramos?",
      "- `diagnostica` — root cause con AI de la crítica más vieja",
      "- `muéstrame las alertas` — lista completa",
      "- `quién está de guardia` — para escalación",
    );
    return lines.join("\n");
  }

  // Branch 2 — failed deploys but no criticals.
  if (failedDeploys.length > 0) {
    const top = failedDeploys[0]!;
    const lines = [
      "¡Hola! 👋",
      "",
      `🟡 **${failedDeploys.length} deploy${failedDeploys.length === 1 ? "" : "s"} fallando** — el más reciente es \`${top.projectName}\` (${timeAgo(top.createdAt)})`,
    ];
    if (warningActive.length > 0) {
      lines.push(`🟡 ${warningActive.length} warning${warningActive.length === 1 ? "" : "s"} activos`);
    }
    if (status) {
      lines.push(`🟢 Uptime: ${status.monitorsTotal - status.monitorsDown}/${status.monitorsTotal} monitores arriba`);
    }
    lines.push(
      "",
      "¿Qué quieres revisar?",
      "- `últimos deploys` — detalle de los fallos",
      "- `por qué falló` — diagnóstico AI del deploy",
      "- `hay algo caído` — uptime de los monitores",
    );
    return lines.join("\n");
  }

  // Branch 3 — everything green (no criticals, no failed deploys).
  const lines = ["¡Hola! 👋", "", "Todo tranquilo:"];
  if (status) {
    lines.push(`🟢 Sin alertas críticas (24h) · ${status.projectCount} proyecto${status.projectCount === 1 ? "" : "s"}`);
    lines.push(`🟢 ${status.monitorsTotal - status.monitorsDown}/${status.monitorsTotal} monitores arriba`);
  } else {
    lines.push("🟢 Sin alertas críticas");
  }
  if (warningActive.length > 0) {
    lines.push(`🟡 ${warningActive.length} warning${warningActive.length === 1 ? "" : "s"} acumulados (no urgentes)`);
  }
  lines.push(
    "",
    "¿Qué exploramos?",
    "- `tendencias de errores` — semana pasada vs esta",
    "- `últimos deploys` — qué se subió",
    "- `quién está de guardia` — turno actual",
  );
  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s  = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function sevEmoji(sev: string): string {
  switch (sev.toLowerCase()) {
    case "critical": return "🔴";
    case "warning":  return "🟡";
    case "info":     return "🔵";
    default:         return "⚪";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
