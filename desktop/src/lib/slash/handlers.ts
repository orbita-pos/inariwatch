/**
 * Handlers for the **structured-output** slash commands — the ones that
 * fetch JSON-shaped data and render it as a markdown table / card / list
 * inline in the chat scrollback.
 *
 * Split out of `slash-dispatch.ts` so the generic dispatcher (echo →
 * catalog → IPC → summary note) stays compact and the per-command
 * rendering logic lives in one obvious place.
 *
 * ## Two flavors
 *
 * - **Tool-routed**: `/projects`, `/health`, `/digest`, `/search`. The
 *   underlying capability is one of the 21 registered chat tools. We
 *   reuse `desktopToolInvokeViaSlash` so the audit row + Deny-respect
 *   guarantees of the standard slash pipeline carry over.
 * - **Cloud-IPC**: `/alerts`, `/alert`, `/uptime`, `/oncall`. These
 *   wrap the desktop dashboard's read-only widget IPCs (`cloud_get_*`)
 *   directly — no tool, no audit row. The IPCs are already in
 *   production from v0.3 Phase A.
 *
 * ## Why duplicate timeAgo / sevEmoji vs reusing intent-router/resolvers
 *
 * Phase 3 of the pure-slash refactor kills the L0 intent-router, taking
 * `resolvers.ts` with it. Importing private helpers from a doomed module
 * would only force a churn commit later. The helpers are 5 lines each —
 * cheaper to duplicate.
 */

import {
  cloudGetAlerts as realCloudGetAlerts,
  cloudGetOncall as realCloudGetOncall,
  cloudGetUptime as realCloudGetUptime,
  type CloudAlert,
  type OncallStatus,
  type UptimeSummary,
} from "../cloud-ipc";
import type { SlashCommand } from "../slash";
import { desktopToolInvokeViaSlash as realDesktopToolInvokeViaSlash } from "../tool-invoke-ipc";
import type { InvokeOutcome } from "../tool-invoke-ipc";
import type { ChatMessage } from "../store/chat";
import type { MemoryEntry, ResolvedEntity } from "./scoped-memory";
import type { SuspendedHandler } from "./suspended-command";

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Cloud-IPC adapter the dispatchers consume. Tests pass a stub; in
 * production the slash dispatcher leaves this `undefined` and we fall
 * through to the real cloud-ipc helpers.
 */
export interface SlashCloudIpc {
  getAlerts: (limit: number) => Promise<CloudAlert[]>;
  getUptime: () => Promise<UptimeSummary>;
  getOncall: () => Promise<OncallStatus>;
}

/**
 * Shape the dispatcher exposes to each handler. Mirrors the relevant
 * subset of `SlashCtx` from `slash-dispatch.ts` — keeping it a separate
 * type lets `handlers.ts` stay independent of the (large) outer module.
 */
export interface SlashHandlerCtx {
  appendMessage: (msg: ChatMessage) => void;
  sessionId: string | null;
  invoke?: (
    toolName: string,
    args: unknown,
    sessionId: string | null,
  ) => Promise<InvokeOutcome>;
  cloudIpc?: SlashCloudIpc;
  /**
   * Phase 5.3 — scoped-memory recorder. Handlers that produce
   * structured output (alerts, projects) call this so the Phase 5.4
   * autocomplete + Phase 5.5+ pickers can see what the user just
   * looked at. Optional — legacy + headless callers omit it; the
   * handlers no-op the call in that case.
   */
  recordMemory?: (entry: Omit<MemoryEntry, "timestamp">) => void;
  /**
   * Phase 5.7 — hand a SuspendedState to the dock surface. Used by
   * structured handlers (`/fix`, future `/health` etc.) when they
   * need a slot picker to fill missing args. Optional — legacy /
   * headless callers omit it; structured handlers fall back to the
   * pre-5.7 error-note path.
   */
  onSuspended?: SuspendedHandler;
}

// ── Helpers (local copies — see header comment) ─────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function sevEmoji(sev: string): string {
  switch (sev.toLowerCase()) {
    case "critical":
      return "🔴";
    case "warning":
      return "🟡";
    case "info":
      return "🔵";
    default:
      return "⚪";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

let counter = 0;
function makeAssistantNote(content: string): ChatMessage {
  counter += 1;
  // Prefix differs from the outer dispatcher's `slash_note_…` ids so
  // two messages pushed in the same millisecond never collide on id.
  return {
    id: `slash_struct_${Date.now()}_${counter}`,
    role: "assistant",
    content,
    createdAt: Date.now(),
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Pull the structured `value` field out of an `InvokeOutcome`. Returns
 * `null` for `denied` / `requires_confirm` — callers surface the
 * appropriate user-facing message and fall through without rendering.
 *
 * Exported for tests so the rendering layer can be exercised in
 * isolation from the IPC dispatch.
 */
export function valueFromOutcome(outcome: InvokeOutcome): unknown | null {
  if (outcome.kind === "output") return outcome.output.value;
  return null;
}

// ── /projects ──────────────────────────────────────────────────────────────

/**
 * Parsed args for `/projects` — only the optional `--integration=<svc>`
 * filter for now. Exported so the dispatcher's drift test can lock the
 * arg→IPC mapping without re-instantiating the parser.
 */
export type ProjectsArgsResult =
  | { args: { integration?: string } }
  | { error: string };

/**
 * Recognised integration filter values. Must match the closed set the
 * Rust tool's schema allows — anything outside this list would be
 * refused server-side anyway, but rejecting client-side gives the user
 * an actionable hint.
 */
const KNOWN_INTEGRATIONS = new Set([
  "capture",
  "github",
  "vercel",
  "agent",
  "datadog",
  "expo",
  "sentry",
]);

export function parseProjectsArgs(raw: string): ProjectsArgsResult {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {} };
  // Single optional flag for v1. Accept either `--integration=<svc>` or
  // bare `--<svc>` for ergonomics. Anything else surfaces a hint.
  const flagMatch = trimmed.match(/^--integration=([a-z_]+)$/i);
  if (flagMatch) {
    const svc = flagMatch[1].toLowerCase();
    if (!KNOWN_INTEGRATIONS.has(svc)) {
      return {
        error: `Unknown integration \`${svc}\`. Try one of: ${[...KNOWN_INTEGRATIONS].join(", ")}.`,
      };
    }
    return { args: { integration: svc } };
  }
  // Allow `--capture`, `--vercel`, etc. as shorthand.
  const shortMatch = trimmed.match(/^--([a-z_]+)$/i);
  if (shortMatch) {
    const svc = shortMatch[1].toLowerCase();
    if (KNOWN_INTEGRATIONS.has(svc)) {
      return { args: { integration: svc } };
    }
  }
  return {
    error:
      "`/projects` takes no positional args. Use `--integration=<capture|github|vercel|agent|datadog|expo|sentry>` to filter.",
  };
}

interface ProjectsValue {
  projects?: Array<{
    id?: unknown;
    name?: unknown;
    state?: unknown;
    workspaceName?: unknown;
    integrations?: unknown;
  }>;
}

/** Render the `cloud.list_projects` value as a markdown table. Public for tests. */
export function renderProjects(value: unknown, filter?: string): string {
  const v = value as ProjectsValue;
  const list = Array.isArray(v?.projects) ? v.projects : [];
  if (list.length === 0) {
    const f = filter ? ` with \`${filter}\`` : "";
    return `**Projects** — none${f}.`;
  }
  const rows = list.map((p) => {
    const name = String(p.name ?? "—");
    const state = String(p.state ?? "—");
    const ws = String(p.workspaceName ?? "—");
    const integrations = Array.isArray(p.integrations)
      ? (p.integrations as unknown[]).map(String).join(", ")
      : "—";
    const id = truncate(String(p.id ?? ""), 8);
    return `| ${name} | ${state} | ${ws} | ${integrations} | \`${id}\` |`;
  });
  const title = filter
    ? `**Projects** — ${list.length} with \`${filter}\``
    : `**Projects** — ${list.length} total`;
  return [
    title,
    "",
    "| Name | State | Workspace | Integrations | ID |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export async function handleProjects(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const argsResult = parseProjectsArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(makeAssistantNote(`\`/projects\`: ${argsResult.error}`));
    return;
  }
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke(
      "cloud.list_projects",
      argsResult.args,
      ctx.sessionId,
    );
    if (outcome.kind === "denied") {
      ctx.appendMessage(makeAssistantNote(outcome.reason));
      return;
    }
    if (outcome.kind !== "output") {
      ctx.appendMessage(
        makeAssistantNote(
          "`/projects` returned `requires_confirm` — slash should bypass Confirm.",
        ),
      );
      return;
    }
    ctx.appendMessage(
      makeAssistantNote(renderProjects(outcome.output.value, argsResult.args.integration)),
    );
    // Phase 5.3 — promote the listed projects to scoped memory.
    // Summary surfaces id + name inline so an autocomplete query
    // like "health el InariWatch" resolves without the LLM having
    // to guess which project the user meant.
    if (ctx.recordMemory) {
      const entities = projectsEntitiesFromValue(outcome.output.value);
      if (entities.length > 0) {
        ctx.recordMemory({
          commandName: "projects",
          args: argsResult.args,
          summary: summarizeProjects(entities),
          entities,
        });
      }
    }
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/projects\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Pluck `(id, name, slug)` from the `cloud.list_projects` value shape
 * we already render. Exported for tests. Returns an empty array when
 * the value isn't shaped as expected — keeps the recorder defensive.
 */
export function projectsEntitiesFromValue(value: unknown): ResolvedEntity[] {
  const v = value as ProjectsValue;
  const list = Array.isArray(v?.projects) ? v.projects : [];
  const out: ResolvedEntity[] = [];
  for (const p of list) {
    const id = typeof p.id === "string" ? p.id : null;
    const name = typeof p.name === "string" ? p.name : null;
    if (!id || !name) continue;
    const slugRaw = (p as { slug?: unknown }).slug;
    const slug = typeof slugRaw === "string" ? slugRaw : undefined;
    out.push({ type: "project", id, name, slug });
  }
  return out;
}

// ── /health <project_id> ───────────────────────────────────────────────────

export type HealthArgsResult =
  | { args: { project_id: string } }
  | { error: string };

export function parseHealthArgs(raw: string): HealthArgsResult {
  const id = raw.trim();
  if (!id) {
    return {
      error: "Project id required. Use `/projects` first to find one.",
    };
  }
  // Same defence as the Rust tool — refuse path-traversal-shaped ids.
  if (id.includes("/") || id.includes("?") || id.includes("#")) {
    return { error: "Project id must be a plain UUID (no `/`, `?`, `#`)." };
  }
  return { args: { project_id: id } };
}

interface HealthValue {
  projectName?: unknown;
  state?: unknown;
  alerts24h?: {
    total?: unknown;
    critical?: unknown;
    warning?: unknown;
    info?: unknown;
  };
  uptime?: {
    monitorsTotal?: unknown;
    monitorsDown?: unknown;
    avgResponseMs?: unknown;
  };
  lastDeploy?: {
    state?: unknown;
    createdAt?: unknown;
  } | null;
  integrations?: unknown;
}

/** Render `cloud.get_project_health` value as a markdown card. Public for tests. */
export function renderHealth(value: unknown): string {
  const v = value as HealthValue;
  const name = String(v?.projectName ?? "—");
  const state = String(v?.state ?? "unknown");
  const stateIcon =
    state === "live" ? "🟢" :
    state === "warning" ? "🟡" :
    state === "critical" ? "🔴" : "⚪";

  const lines: string[] = [`**${stateIcon} ${name}** — ${state}`, ""];

  const a = v?.alerts24h;
  if (a) {
    const parts: string[] = [];
    if (typeof a.critical === "number" && a.critical > 0) parts.push(`🔴 ${a.critical} critical`);
    if (typeof a.warning === "number" && a.warning > 0) parts.push(`🟡 ${a.warning} warning`);
    if (typeof a.info === "number" && a.info > 0) parts.push(`🔵 ${a.info} info`);
    const total = typeof a.total === "number" ? a.total : 0;
    lines.push(`**Alerts (24h):** ${total === 0 ? "none ✅" : parts.join(" · ")}`);
  }

  const u = v?.uptime;
  if (u && typeof u.monitorsTotal === "number") {
    const down = typeof u.monitorsDown === "number" ? u.monitorsDown : 0;
    const avg = typeof u.avgResponseMs === "number" ? ` · avg ${u.avgResponseMs}ms` : "";
    lines.push(
      `**Uptime:** ${down === 0 ? "all up ✅" : `${down}/${u.monitorsTotal} down`}${avg}`,
    );
  }

  if (v?.lastDeploy && typeof v.lastDeploy.state === "string") {
    const ago =
      typeof v.lastDeploy.createdAt === "string"
        ? ` · ${timeAgo(v.lastDeploy.createdAt)} ago`
        : "";
    lines.push(`**Last deploy:** ${v.lastDeploy.state}${ago}`);
  }

  if (Array.isArray(v?.integrations) && v.integrations.length > 0) {
    lines.push(
      `**Integrations:** ${(v.integrations as unknown[]).map(String).join(", ")}`,
    );
  }

  return lines.join("\n");
}

export async function handleHealth(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  // Phase 5.8 — suspend with ProjectPickerSlot when no project_id is
  // provided AND the surface wired `onSuspended`. Picker reads
  // scoped memory to promote the project the user just installed /
  // listed; valid args fall through to the existing tool dispatch.
  if (
    typeof ctx.onSuspended === "function" &&
    parsed.args.trim().length === 0
  ) {
    ctx.onSuspended({
      needs: {
        kind: "project",
        name: "project_id",
        prompt: "which project?",
        placeholder: "Search projects…",
      },
      partial: {
        command: "health",
        collectedArgs: {},
        rawArgs: "",
      },
      rebuild: healthRebuild,
    });
    return;
  }

  const argsResult = parseHealthArgs(parsed.args);
  if ("error" in argsResult) {
    if (typeof ctx.onSuspended === "function") {
      ctx.onSuspended({
        needs: {
          kind: "project",
          name: "project_id",
          prompt: "which project?",
          placeholder: "Search projects…",
        },
        partial: {
          command: "health",
          collectedArgs: {},
          rawArgs: parsed.args,
        },
        rebuild: healthRebuild,
      });
      return;
    }
    ctx.appendMessage(makeAssistantNote(`\`/health\`: ${argsResult.error}`));
    return;
  }
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke(
      "cloud.get_project_health",
      argsResult.args,
      ctx.sessionId,
    );
    if (outcome.kind === "denied") {
      ctx.appendMessage(makeAssistantNote(outcome.reason));
      return;
    }
    if (outcome.kind !== "output") {
      ctx.appendMessage(
        makeAssistantNote(
          "`/health` returned `requires_confirm` — slash should bypass Confirm.",
        ),
      );
      return;
    }
    ctx.appendMessage(makeAssistantNote(renderHealth(outcome.output.value)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/health\` failed: ${formatError(err)}`),
    );
  }
}

// ── /digest ────────────────────────────────────────────────────────────────

interface DigestValue {
  totalAlerts24h?: unknown;
  alertsCritical24h?: unknown;
  alertsWarning24h?: unknown;
  monitorsDown?: unknown;
  monitorsTotal?: unknown;
  projectCount?: unknown;
  topNoisyProject?: {
    name?: unknown;
    alerts24h?: unknown;
  } | null;
  onCallSummary?: {
    primary?: { name?: unknown; email?: unknown } | null;
  } | null;
  lastAlertAt?: unknown;
}

/** Render `cloud.get_workspace_summary` value as a markdown card. Public for tests. */
export function renderDigest(value: unknown): string {
  const v = value as DigestValue;
  const total = typeof v?.totalAlerts24h === "number" ? v.totalAlerts24h : 0;
  const critical = typeof v?.alertsCritical24h === "number" ? v.alertsCritical24h : 0;
  const warning = typeof v?.alertsWarning24h === "number" ? v.alertsWarning24h : 0;
  const monitorsDown = typeof v?.monitorsDown === "number" ? v.monitorsDown : 0;
  const monitorsTotal = typeof v?.monitorsTotal === "number" ? v.monitorsTotal : 0;
  const projects = typeof v?.projectCount === "number" ? v.projectCount : 0;

  const headline =
    critical > 0 || monitorsDown > 0
      ? `**Workspace digest** — 🔴 attention needed`
      : `**Workspace digest** — 🟢 all clear`;

  const lines: string[] = [headline, ""];
  const alertParts: string[] = [];
  if (critical > 0) alertParts.push(`🔴 ${critical} critical`);
  if (warning > 0) alertParts.push(`🟡 ${warning} warning`);
  lines.push(
    `**Alerts (24h):** ${total} total${alertParts.length ? ` · ${alertParts.join(" · ")}` : ""}`,
  );

  lines.push(
    `**Monitors:** ${monitorsDown === 0 ? `all up ✅ (${monitorsTotal})` : `${monitorsDown}/${monitorsTotal} down`}`,
  );

  lines.push(`**Projects:** ${projects}`);

  if (v?.topNoisyProject && typeof v.topNoisyProject.name === "string") {
    const count = typeof v.topNoisyProject.alerts24h === "number" ? v.topNoisyProject.alerts24h : 0;
    lines.push(`**Top noisy:** \`${v.topNoisyProject.name}\` — ${count} alerts`);
  }

  const oc = v?.onCallSummary?.primary;
  if (oc) {
    const who = typeof oc.name === "string" && oc.name
      ? oc.name
      : typeof oc.email === "string"
        ? oc.email
        : "—";
    lines.push(`**On-call:** ${who}`);
  }

  if (typeof v?.lastAlertAt === "string") {
    lines.push(`**Last alert:** ${timeAgo(v.lastAlertAt)} ago`);
  }

  return lines.join("\n");
}

export async function handleDigest(
  _parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke("cloud.get_workspace_summary", {}, ctx.sessionId);
    if (outcome.kind === "denied") {
      ctx.appendMessage(makeAssistantNote(outcome.reason));
      return;
    }
    if (outcome.kind !== "output") {
      ctx.appendMessage(
        makeAssistantNote(
          "`/digest` returned `requires_confirm` — slash should bypass Confirm.",
        ),
      );
      return;
    }
    ctx.appendMessage(makeAssistantNote(renderDigest(outcome.output.value)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/digest\` failed: ${formatError(err)}`),
    );
  }
}

// ── /search ────────────────────────────────────────────────────────────────

export type SearchArgsResult =
  | { args: { error_text: string } }
  | { error: string };

export function parseSearchArgs(raw: string): SearchArgsResult {
  const query = raw.trim();
  if (!query) {
    return {
      error: "Query required. Try `/search TypeError: Cannot read properties of undefined`.",
    };
  }
  if (query.length > 8192) {
    return { error: "Query too long (max 8 KB). Trim it down." };
  }
  return { args: { error_text: query } };
}

interface SearchResultHit {
  title?: unknown;
  url?: unknown;
  source?: unknown;
  excerpt?: unknown;
}

interface SearchValue {
  results?: SearchResultHit[];
  hits?: SearchResultHit[];
}

/** Render `search.error_context` value as a markdown list. Public for tests. */
export function renderSearch(value: unknown, query: string): string {
  const v = value as SearchValue;
  const hits = Array.isArray(v?.results) ? v.results : Array.isArray(v?.hits) ? v.hits : [];
  if (hits.length === 0) {
    return `**Search** \`${truncate(query, 60)}\` — no hits.`;
  }
  const rows = hits.slice(0, 8).map((h, i) => {
    const title = truncate(String(h.title ?? "—"), 80);
    const source = String(h.source ?? "web");
    const url = typeof h.url === "string" ? h.url : null;
    const link = url ? `[${title}](${url})` : title;
    return `${i + 1}. ${link} _(${source})_`;
  });
  return [
    `**Search** \`${truncate(query, 60)}\` — ${hits.length} hit${hits.length === 1 ? "" : "s"}`,
    "",
    ...rows,
  ].join("\n");
}

export async function handleSearch(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const argsResult = parseSearchArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(makeAssistantNote(`\`/search\`: ${argsResult.error}`));
    return;
  }
  const invoke = ctx.invoke ?? realDesktopToolInvokeViaSlash;
  try {
    const outcome = await invoke(
      "search.error_context",
      argsResult.args,
      ctx.sessionId,
    );
    if (outcome.kind === "denied") {
      ctx.appendMessage(makeAssistantNote(outcome.reason));
      return;
    }
    if (outcome.kind !== "output") {
      ctx.appendMessage(
        makeAssistantNote(
          "`/search` returned `requires_confirm` — slash should bypass Confirm.",
        ),
      );
      return;
    }
    ctx.appendMessage(
      makeAssistantNote(renderSearch(outcome.output.value, argsResult.args.error_text)),
    );
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/search\` failed: ${formatError(err)}`),
    );
  }
}

// ── /alerts [limit] ────────────────────────────────────────────────────────

export type AlertsArgsResult =
  | { args: { limit: number } }
  | { error: string };

export function parseAlertsArgs(raw: string): AlertsArgsResult {
  const trimmed = raw.trim();
  if (!trimmed) return { args: { limit: 20 } };
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) {
    return {
      error: "Limit must be a positive integer. Try `/alerts` (default 20) or `/alerts 50`.",
    };
  }
  if (n > 100) {
    return { error: "Limit cap is 100. Try `/alerts 100`." };
  }
  return { args: { limit: n } };
}

/** Render an alerts list as a markdown table. Public for tests. */
export function renderAlerts(alerts: CloudAlert[]): string {
  const active = alerts.filter((a) => !a.isResolved);
  if (active.length === 0) {
    return "**Alerts** — none active ✅";
  }
  const critical = active.filter((a) => a.severity === "critical").length;
  const warning = active.filter((a) => a.severity === "warning").length;
  const rest = active.length - critical - warning;

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning`);
  if (rest > 0) parts.push(`${rest} other`);

  const rows = active.slice(0, 20).map((a) => {
    const age = timeAgo(a.createdAt);
    const title = truncate(a.title, 50);
    const hash = a.inariHash ? `\`${a.inariHash.slice(0, 8)}\`` : "—";
    return `| ${sevEmoji(a.severity)} | ${title} | ${a.projectName} | ${age} | ${hash} |`;
  });

  return [
    `**Alerts** — ${parts.join(" · ")}`,
    "",
    "| | Title | Project | Age | Hash |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export async function handleAlerts(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const argsResult = parseAlertsArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(makeAssistantNote(`\`/alerts\`: ${argsResult.error}`));
    return;
  }
  const getAlerts = ctx.cloudIpc?.getAlerts ?? realCloudGetAlerts;
  try {
    const alerts = await getAlerts(argsResult.args.limit);
    ctx.appendMessage(makeAssistantNote(renderAlerts(alerts)));
    // Phase 5.3 — promote the active alerts to scoped memory so a
    // follow-up "fixea esa alerta" / "the last one" resolves against
    // a concrete id. Resolved alerts are excluded — they're greyed
    // in the picker but shouldn't be the resolver's default target.
    if (ctx.recordMemory) {
      const active = alerts.filter((a) => !a.isResolved);
      const entities: ResolvedEntity[] = active.slice(0, 20).map((a) => ({
        type: "alert",
        id: a.id,
        hash: a.inariHash,
        title: a.title,
        severity: a.severity,
      }));
      ctx.recordMemory({
        commandName: "alerts",
        args: argsResult.args,
        summary: summarizeAlerts(active),
        entities,
      });
    }
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/alerts\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Rich summary for memory + autocomplete prompt context.
 *
 * Surfaces both the canonical IDs (`inari:alert:<hash>` or fallback
 * UUID) AND a short discriminator (title + HH:MM) so an LLM
 * processing the autocomplete prompt can resolve free-form
 * references like "fixea la del payment" or "esa que era del pool de
 * DB" — the deterministic regex resolver only handles common
 * pronouns / ordinals. Without the discriminator, the LLM has no way
 * to tell which alert is "del payment".
 *
 * Caps at the first 5 active alerts + a "(+N more)" tail so the
 * summary fits in one prompt line without bloating the
 * scoped-memory entry beyond the LLM's attention budget.
 *
 * Pure function — exported for tests.
 */
export function summarizeAlerts(active: CloudAlert[]): string {
  if (active.length === 0) return "no active alerts";
  const critical = active.filter((a) => a.severity === "critical").length;
  const warning = active.filter((a) => a.severity === "warning").length;
  const rest = active.length - critical - warning;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning`);
  if (rest > 0) parts.push(`${rest} other`);
  const headline = `${active.length} active (${parts.join(" · ")})`;

  const items = active.slice(0, 5).map((a) => {
    const ref = a.inariHash
      ? `inari:alert:${a.inariHash.slice(0, 8)}`
      : a.id;
    // "HH:MM" extracted from the ISO timestamp — keeps the summary
    // deterministic (no Date.now()) while giving the LLM a clock-time
    // discriminator. Falls through to "" when the timestamp is
    // malformed so we never inject "undefined" into the prompt.
    const clock = typeof a.createdAt === "string" && a.createdAt.length >= 16
      ? a.createdAt.slice(11, 16)
      : "";
    const stamp = clock ? ` ${clock}` : "";
    return `${ref} (${truncate(a.title, 60)}${stamp})`;
  });
  const more = active.length > 5 ? ` (+${active.length - 5} more)` : "";
  return `${headline}: ${items.join(", ")}${more}`;
}

/**
 * Rich summary for projects — mirrors `summarizeAlerts`. Inlines a
 * short id prefix (first 8 chars of the UUID) + the project name as
 * discriminator. Caps at 5 projects + a `(+N more)` tail. Used by
 * the scoped-memory recorder in `handleProjects` so autocomplete
 * prompts can resolve "ese proyecto" / "el InariWatch" naturally.
 */
export function summarizeProjects(entities: ResolvedEntity[]): string {
  if (entities.length === 0) return "no projects";
  const projects = entities.filter(
    (e): e is Extract<ResolvedEntity, { type: "project" }> => e.type === "project",
  );
  if (projects.length === 0) return "no projects";
  const items = projects.slice(0, 5).map((p) => {
    const ref = p.id.length > 8 ? p.id.slice(0, 8) : p.id;
    return `${ref} (${truncate(p.name, 40)})`;
  });
  const more = projects.length > 5 ? ` (+${projects.length - 5} more)` : "";
  return `${projects.length} project${projects.length === 1 ? "" : "s"}: ${items.join(", ")}${more}`;
}

// ── /alert <hash> ──────────────────────────────────────────────────────────

export type AlertArgsResult =
  | { args: { hash: string } }
  | { error: string };

export function parseAlertArgs(raw: string): AlertArgsResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      error: "Inari hash required. Try `/alert 1a2b3c4d…` (16-hex suffix of an `inari:alert:…` reference).",
    };
  }
  // Accept either the bare 16-hex suffix or a full `inari:alert:<hash>` ref.
  const stripped = trimmed.replace(/^inari:alert:/i, "");
  if (!/^[a-f0-9]{4,16}$/i.test(stripped)) {
    return {
      error: "Hash must be 4-16 hex chars (the suffix after `inari:alert:`).",
    };
  }
  return { args: { hash: stripped.toLowerCase() } };
}

/** Render a single alert as a markdown card. Public for tests. */
export function renderAlertCard(alert: CloudAlert): string {
  const age = timeAgo(alert.createdAt);
  const sev = sevEmoji(alert.severity);
  const lines: string[] = [
    `${sev} **${alert.title}**`,
    `_${alert.projectName} · ${age} ago · ${alert.severity}_`,
    "",
  ];
  if (alert.inariHash) {
    lines.push(`**Hash:** \`inari:alert:${alert.inariHash}\``);
  }
  if (alert.aiReasoning) {
    lines.push("", "**AI analysis:**", alert.aiReasoning);
  } else if (alert.body) {
    lines.push("", "**Body:**", truncate(alert.body, 600));
  }
  if (alert.sourceIntegrations.length > 0) {
    lines.push("", `**Source:** ${alert.sourceIntegrations.join(", ")}`);
  }
  return lines.join("\n");
}

export async function handleAlert(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const argsResult = parseAlertArgs(parsed.args);
  if ("error" in argsResult) {
    ctx.appendMessage(makeAssistantNote(`\`/alert\`: ${argsResult.error}`));
    return;
  }
  const getAlerts = ctx.cloudIpc?.getAlerts ?? realCloudGetAlerts;
  try {
    // No dedicated hash-lookup IPC yet — fetch the recent window and
    // filter client-side. 100 alerts covers the typical "what's that
    // alert I saw earlier" use case; older alerts need the web app.
    const alerts = await getAlerts(100);
    const target = alerts.find((a) =>
      a.inariHash ? a.inariHash.startsWith(argsResult.args.hash) : false,
    );
    if (!target) {
      ctx.appendMessage(
        makeAssistantNote(
          `\`/alert\`: no alert in the last 100 matches hash \`${argsResult.args.hash}\`. Open the web app for older alerts.`,
        ),
      );
      return;
    }
    ctx.appendMessage(makeAssistantNote(renderAlertCard(target)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/alert\` failed: ${formatError(err)}`),
    );
  }
}

// ── /fix <hash> — Phase 5.7 pilot ──────────────────────────────────────────

export type FixArgsResult =
  | { args: { hash: string } }
  | { error: string };

/**
 * Same hash parsing as `/alert` — accept the bare 16-hex suffix OR a
 * full `inari:alert:<hash>` reference. Pure function, exported for
 * tests + suspend integration.
 */
export function parseFixArgs(raw: string): FixArgsResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      error: "Inari hash required. Try `/fix 1a2b3c4d…` or pick an alert from the inline picker.",
    };
  }
  const stripped = trimmed.replace(/^inari:alert:/i, "");
  if (!/^[a-f0-9]{4,16}$/i.test(stripped)) {
    return {
      error: "Hash must be 4-16 hex chars (the suffix after `inari:alert:`).",
    };
  }
  return { args: { hash: stripped.toLowerCase() } };
}

/**
 * Render the "remediation queued" assistant note for a resolved
 * alert. Pure function, exported for tests. Phase 7+ will turn this
 * into a real progress card backed by the remediation IPC; for now
 * the note tells the user how to follow up via the existing
 * AlertDetailPanel (Cmd+\).
 */
export function renderFixQueued(alert: CloudAlert): string {
  const hashRef = alert.inariHash
    ? `\`inari:alert:${alert.inariHash}\``
    : `\`${alert.id}\``;
  return [
    `${sevEmoji(alert.severity)} Remediation queued for ${hashRef}`,
    `_${truncate(alert.title, 70)} · ${alert.projectName}_`,
    "",
    "Open the alert detail panel (`Cmd+\\`) to watch the pipeline progress.",
  ].join("\n");
}

/**
 * Phase 5.7 — `/fix <hash>` handler. Suspends with an AlertPickerSlot
 * when no hash is provided AND the surface wired `onSuspended`;
 * otherwise looks up the alert + surfaces the "remediation queued"
 * note. The lookup-then-note pattern mirrors `handleAlert`; the
 * difference is the user-facing copy plus the (future) pipeline kick.
 */
export async function handleFix(
  parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const canSuspend = typeof ctx.onSuspended === "function";

  // Empty args + suspend-aware caller → hand the alert picker. The
  // picker reads scoped memory to promote recently-listed alerts so
  // a `/fix` right after `/alerts` shows the same set up top.
  if (canSuspend && parsed.args.trim().length === 0) {
    ctx.onSuspended!({
      needs: {
        kind: "alert",
        name: "hash",
        prompt: "which alert?",
        placeholder: "Search alerts (title, hash, severity)…",
      },
      partial: {
        command: "fix",
        collectedArgs: {},
        rawArgs: "",
      },
      rebuild: fixRebuild,
    });
    return;
  }

  const argsResult = parseFixArgs(parsed.args);
  if ("error" in argsResult) {
    if (canSuspend) {
      ctx.onSuspended!({
        needs: {
          kind: "alert",
          name: "hash",
          prompt: "which alert?",
          placeholder: "Search alerts (title, hash, severity)…",
        },
        partial: { command: "fix", collectedArgs: {}, rawArgs: parsed.args },
        rebuild: fixRebuild,
      });
      return;
    }
    ctx.appendMessage(makeAssistantNote(`\`/fix\`: ${argsResult.error}`));
    return;
  }

  const getAlerts = ctx.cloudIpc?.getAlerts ?? realCloudGetAlerts;
  try {
    const alerts = await getAlerts(100);
    const target = alerts.find((a) =>
      a.inariHash ? a.inariHash.startsWith(argsResult.args.hash) : false,
    );
    if (!target) {
      ctx.appendMessage(
        makeAssistantNote(
          `\`/fix\`: no alert in the last 100 matches hash \`${argsResult.args.hash}\`. Open the web app for older alerts.`,
        ),
      );
      return;
    }
    ctx.appendMessage(makeAssistantNote(renderFixQueued(target)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/fix\` failed: ${formatError(err)}`),
    );
  }
}

/**
 * Serialise a resumed /fix. The picker resolves to an
 * `{kind: "alert"}` value that merges into `{hash, alert_hash,
 * alert_display}`. We dispatch on `hash` so the parsed input lines
 * up with what `parseFixArgs` expects.
 */
export function fixRebuild(args: Record<string, unknown>): string {
  // Prefer the `hash` slot value, fall back to `alert_hash` (set by
  // mergeSlotValue for alert entities), then to the raw alert id.
  const hash =
    typeof args.hash === "string" && args.hash.length > 0
      ? args.hash
      : typeof args.alert_hash === "string"
        ? args.alert_hash
        : typeof args.alert === "string"
          ? args.alert
          : "";
  return `/fix ${hash}`;
}

/**
 * Phase 5.8 — serialise a resumed /health. Picker resolves to an
 * `{kind: "project"}` value; mergeSlotValue maps `id → project_id`
 * (via the slot's `name="project_id"`), so we use that key directly.
 */
export function healthRebuild(args: Record<string, unknown>): string {
  const id = typeof args.project_id === "string" ? args.project_id : "";
  return `/health ${id}`;
}

// ── /uptime ────────────────────────────────────────────────────────────────

/** Render an `UptimeSummary` as a markdown list. Public for tests. */
export function renderUptime(summary: UptimeSummary): string {
  const { monitors, downCount, avgResponseMs } = summary;
  if (monitors.length === 0) return "**Uptime** — no monitors configured.";
  const avgPart = avgResponseMs != null ? ` · avg ${avgResponseMs}ms` : "";
  const header = `**Uptime** — ${downCount > 0 ? `${downCount} down` : "all up ✅"}${avgPart}`;
  const rows = monitors.slice(0, 20).map((m) => {
    const icon = m.isDown ? "🔴" : "🟢";
    const name = m.name ?? m.url;
    if (m.isDown) {
      return `${icon} **${name}** — down (${m.consecutiveFailures} failure${m.consecutiveFailures !== 1 ? "s" : ""})`;
    }
    const ms = m.lastResponseTimeMs != null ? ` — ${m.lastResponseTimeMs}ms` : "";
    return `${icon} ${name}${ms}`;
  });
  return [header, "", ...rows].join("\n");
}

export async function handleUptime(
  _parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const getUptime = ctx.cloudIpc?.getUptime ?? realCloudGetUptime;
  try {
    const summary = await getUptime();
    ctx.appendMessage(makeAssistantNote(renderUptime(summary)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/uptime\` failed: ${formatError(err)}`),
    );
  }
}

// ── /oncall ────────────────────────────────────────────────────────────────

/** Render an `OncallStatus` as a markdown table. Public for tests. */
export function renderOncall(status: OncallStatus): string {
  if (status.schedules.length === 0) {
    return "**On-call** — no schedules configured.";
  }
  const rows = status.schedules.map((s) => {
    const primary = s.primary?.name ?? s.primary?.email ?? "—";
    const secondary = s.secondary?.name ?? s.secondary?.email ?? "—";
    const override = s.hasActiveOverride ? " 🔄" : "";
    return `| ${s.projectName} | ${primary}${override} | ${secondary} |`;
  });
  return [
    `**On-call** — ${status.schedules.length} schedule${status.schedules.length === 1 ? "" : "s"}`,
    "",
    "| Project | Primary | Secondary |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

export async function handleOncall(
  _parsed: SlashCommand,
  ctx: SlashHandlerCtx,
): Promise<void> {
  const getOncall = ctx.cloudIpc?.getOncall ?? realCloudGetOncall;
  try {
    const status = await getOncall();
    ctx.appendMessage(makeAssistantNote(renderOncall(status)));
  } catch (err) {
    ctx.appendMessage(
      makeAssistantNote(`\`/oncall\` failed: ${formatError(err)}`),
    );
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

/**
 * Map of structured / cloud-IPC slash commands to their handler. The
 * outer dispatcher checks this map before the standard catalog lookup
 * so a structured command never falls through to the generic
 * "tool ran, here's the one-line summary" code path.
 */
export const STRUCTURED_HANDLERS: Record<
  string,
  (parsed: SlashCommand, ctx: SlashHandlerCtx) => Promise<void>
> = {
  projects: handleProjects,
  health: handleHealth,
  digest: handleDigest,
  search: handleSearch,
  alerts: handleAlerts,
  alert: handleAlert,
  uptime: handleUptime,
  oncall: handleOncall,
  fix: handleFix,
};
