/**
 * v0.3 Phase A — typed wrappers for the 6 read-only cloud-dashboard
 * widget commands.
 *
 * Each helper:
 *  - Calls `invoke()` against the matching Rust IPC command.
 *  - Surfaces a normalized `CloudError` discriminated union so the panel
 *    can render distinct empty / unauthorized / transport-error states.
 *  - Stays cheap when the Tauri runtime isn't present (vitest / jsdom /
 *    storybook) — `invoke()` rejects with `"command … not found"` and the
 *    caller catches.
 *
 * DTOs mirror `crate::cloud::widgets`. Hand-written instead of ts-rs so
 * the panel ships in one session without a backend rebuild dependency.
 */

import { invoke } from "@tauri-apps/api/core";

// ── DTOs ─────────────────────────────────────────────────────────────

export interface CloudAlert {
  id: string;
  title: string;
  body: string | null;
  severity: "critical" | "warning" | "info" | string;
  aiReasoning: string | null;
  sourceIntegrations: string[];
  projectName: string;
  fingerprint: string | null;
  inariHash: string | null;
  isRead: boolean;
  isResolved: boolean;
  createdAt: string;
}

export interface UptimeMonitorRow {
  id: string;
  name: string | null;
  url: string;
  isDown: boolean;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastResponseTimeMs: number | null;
}

export interface UptimeSummary {
  monitors: UptimeMonitorRow[];
  downCount: number;
  total: number;
  avgResponseMs: number | null;
}

export interface DeployRow {
  id: string;
  projectName: string;
  title: string;
  severity: string;
  state: "success" | "failed" | "building" | "unknown" | string;
  createdAt: string;
}

export interface DeploySummary {
  deploys: DeployRow[];
  failedCount: number;
}

export interface OncallUser {
  userId: string;
  name: string | null;
  email: string | null;
}

export interface OncallScheduleRow {
  projectId: string;
  projectName: string;
  scheduleName: string;
  timezone: string;
  primary: OncallUser | null;
  secondary: OncallUser | null;
  hasActiveOverride: boolean;
}

export interface OncallStatus {
  schedules: OncallScheduleRow[];
  totalAssignments: number;
}

export interface TrendingFix {
  id: string;
  patternId: string;
  patternTitle: string;
  fixApproach: string;
  fixDescription: string;
  successCount: number;
  failureCount: number;
  successRate: number;
  totalApplications: number;
}

export interface StatusSummary {
  state: "operational" | "degraded" | "outage" | string;
  alertsCritical24h: number;
  alertsWarning24h: number;
  monitorsDown: number;
  monitorsTotal: number;
  projectCount: number;
  lastAlertAt: string | null;
}

// ── Error normalization ──────────────────────────────────────────────

export type CloudErrorKind =
  | "not_connected"
  | "unauthorized"
  | "network"
  | "ipc_unavailable"
  | "other";

export class CloudError extends Error {
  kind: CloudErrorKind;
  constructor(kind: CloudErrorKind, message: string) {
    super(message);
    this.name = "CloudError";
    this.kind = kind;
  }
}

function classify(err: unknown): CloudError {
  const msg = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  if (msg.includes("not_connected")) return new CloudError("not_connected", msg);
  if (msg.includes("unauthorized") || /\b401\b/.test(msg)) {
    return new CloudError("unauthorized", msg);
  }
  if (/command .* not found|tauri runtime/i.test(msg)) {
    return new CloudError("ipc_unavailable", msg);
  }
  if (msg.startsWith("network") || msg.startsWith("HTTP ") || msg.startsWith("parse")) {
    return new CloudError("network", msg);
  }
  return new CloudError("other", msg);
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await invoke(name, args)) as T;
  } catch (err) {
    throw classify(err);
  }
}

// ── Public wrappers ──────────────────────────────────────────────────

export async function cloudGetAlerts(limit = 20): Promise<CloudAlert[]> {
  return call<CloudAlert[]>("cloud_get_alerts", { limit });
}

export async function cloudGetUptime(): Promise<UptimeSummary> {
  return call<UptimeSummary>("cloud_get_uptime");
}

export async function cloudGetDeploys(limit = 8): Promise<DeploySummary> {
  return call<DeploySummary>("cloud_get_deploys", { limit });
}

export async function cloudGetOncall(): Promise<OncallStatus> {
  return call<OncallStatus>("cloud_get_oncall");
}

export async function cloudGetCommunityTrending(limit = 8): Promise<TrendingFix[]> {
  return call<TrendingFix[]>("cloud_get_community_trending", { limit });
}

export async function cloudGetStatusSummary(): Promise<StatusSummary> {
  return call<StatusSummary>("cloud_get_status_summary");
}

// ── Error trends ─────────────────────────────────────────────────────

export interface TrendDay {
  date: string;
  severity: string;
  count: number;
}

export interface TopError {
  title: string;
  severity: string;
  count: number;
}

export interface TrendsSummary {
  current: number;
  previous: number;
  daily: TrendDay[];
  topErrors: TopError[];
}

export async function cloudGetTrends(days = 7, project?: string): Promise<TrendsSummary> {
  return call<TrendsSummary>("cloud_get_trends", { days, project: project ?? null });
}

// ── Root cause ───────────────────────────────────────────────────────

export interface RootCauseItem {
  id: string;
  title: string;
  severity: string;
  body: string | null;
  projectName: string;
  aiReasoning: string | null;
  isResolved: boolean;
  createdAt: string;
}

export async function cloudGetRootCause(alertId?: string, project?: string): Promise<RootCauseItem> {
  return call<RootCauseItem>("cloud_get_root_cause", { alertId: alertId ?? null, project: project ?? null });
}

// ── Alert mutations ──────────────────────────────────────────────────

export interface MutationResult {
  ok: boolean;
  title?: string;
}

export async function cloudAckAlert(alertId?: string, project?: string): Promise<MutationResult> {
  return call<MutationResult>("cloud_ack_alert", { alertId: alertId ?? null, project: project ?? null });
}

export async function cloudSilenceAlert(alertId?: string, project?: string): Promise<MutationResult> {
  return call<MutationResult>("cloud_silence_alert", { alertId: alertId ?? null, project: project ?? null });
}

// ── Auth helpers (re-exported from existing surface) ────────────────
//
// These are already implemented in `crate::ipc::auth` but exposed here so
// the dashboard panel doesn't need to import from two modules.

export interface AuthStatus {
  connected: boolean;
  api_url: string;
  watch_dir: string | null;
  /** Session 1 — server-issued device id when paired post-S1. Null on
   *  pre-S1 installs (legacy api_keys path) until the user re-pairs. */
  device_id: string | null;
}

export interface DeviceFlowStarted {
  code: string;
  verify_url: string;
  api_url: string;
}

export async function cloudAuthStatus(): Promise<AuthStatus> {
  return call<AuthStatus>("desktop_auth_status");
}

export async function cloudAuthStart(): Promise<DeviceFlowStarted> {
  return call<DeviceFlowStarted>("desktop_auth_start");
}

export async function cloudAuthPoll(code: string, apiUrl: string): Promise<string> {
  return call<string>("desktop_auth_poll", { code, apiUrl });
}

export async function cloudLogout(): Promise<unknown> {
  return call("desktop_logout");
}

// ── Devices (Session 1) ─────────────────────────────────────────────

export interface DeviceRow {
  deviceId:    string;
  label:       string;
  os:          string | null;
  hostname:    string | null;
  appVersion:  string | null;
  createdAt:   string;
  lastSeenAt:  string;
  isCurrent:   boolean;
}

export interface DeviceList {
  devices: DeviceRow[];
  currentDeviceId: string | null;
}

export interface SignOutAllResult {
  ok: boolean;
  revokedCount: number;
}

export async function cloudDevicesList(): Promise<DeviceList> {
  return call<DeviceList>("desktop_devices_list");
}

export async function cloudDevicesRename(deviceId: string, label: string): Promise<void> {
  await call<void>("desktop_devices_rename", { deviceId, label });
}

export async function cloudDevicesRevoke(deviceId: string): Promise<void> {
  await call<void>("desktop_devices_revoke", { deviceId });
}

export async function cloudDevicesSignOutAll(): Promise<SignOutAllResult> {
  return call<SignOutAllResult>("desktop_devices_sign_out_all");
}

/**
 * Tauri event name fired by the Rust backend when a 401 invalidates the
 * locally-cached bearer (revoke from web, sign-out-all from another
 * device, server cleared the row, etc.). Frontend listeners flip the
 * Connect screen + clear cached AuthStatus.
 */
export const EVT_AUTH_REQUIRED = "cloud-auth-required";

// ── Projects (Inari Live V1 — Settings → Projects panel) ────────────

/**
 * Project state machine — mirrors the CHECK constraint in migration
 * 0091. Inari Live's panel groups `created` / `needs_setup` /
 * `setting_up` under a single "Needs setup" pill so the user knows
 * action is required without having to learn the internal state names.
 */
export type ProjectState =
  | "created"
  | "needs_setup"
  | "setting_up"
  | "prepared"
  | "verified"
  | "live"
  | "archived";

export interface ProjectRow {
  id:              string;
  name:            string;
  slug:            string;
  state:           ProjectState | string;
  framework:       string | null;
  host:            string | null;
  organizationId:  string | null;
  /** "Personal" for personal-workspace rows, or the org name. */
  workspaceName:   string | null;
  createdAt:       string;
  lastActivityAt:  string | null;
}

export interface ProjectList {
  projects: ProjectRow[];
}

export async function cloudProjectsList(): Promise<ProjectList> {
  return call<ProjectList>("cloud_projects_list");
}

// ── Inari Live V1 — Session 5: conversations ──────────────────────────────

export type ConversationState = "active" | "snoozed" | "resolved" | "archived";

export interface ConversationListRow {
  id: string;
  title: string;
  state: ConversationState;
  anchorAlertId: string | null;
  lastMessageAt: string;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  workspaceId: string | null;
  alertSeverity: string | null;
  alertSourceIntegrations: string[] | null;
  unreadHint: boolean;
  /** First 120 chars of latest message; null on empty threads. */
  lastMessageSnippet: string | null;
  /** Role of the author of `lastMessageSnippet`. */
  lastMessageRole: "user" | "assistant" | "tool" | "system" | null;
}

export interface ConversationListResult {
  conversations: ConversationListRow[];
}

export interface ConversationRow {
  id: string;
  title: string;
  state: ConversationState;
  anchorAlertId: string | null;
  lastMessageAt: string;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  workspaceId: string | null;
  createdAt: string;
  activeDeviceId: string | null;
}

export interface ConversationMessageRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  contentJson: { text?: string; meta?: Record<string, unknown> } | unknown;
  toolCallId: string | null;
  createdAt: string;
  deviceId: string | null;
  prevMessageHash: string | null;
  messageHash: string | null;
}

export interface ConversationDetail {
  conversation: ConversationRow;
  alert: unknown | null;
  messages: ConversationMessageRow[];
}

export interface VerifyChainResult {
  ok: boolean;
  totalMessages: number;
  firstBreakAt: {
    messageId: string;
    expected: string;
    actual: string | null;
    reason: "missing_hash" | "wrong_prev" | "wrong_hash";
  } | null;
}

export interface ConversationListFilter {
  state?: string;
  severity?: string;
  mine?: boolean;
  q?: string;
  limit?: number;
}

export async function cloudConversationsList(
  filter?: ConversationListFilter,
): Promise<ConversationListResult> {
  return call<ConversationListResult>("cloud_conversations_list", { filter });
}

export async function cloudConversationsGet(id: string): Promise<ConversationDetail> {
  return call<ConversationDetail>("cloud_conversations_get", { id });
}

export async function cloudConversationsPostMessage(
  id: string,
  content: string,
  deviceId?: string | null,
): Promise<ConversationMessageRow> {
  return call<ConversationMessageRow>("cloud_conversations_post_message", {
    id,
    content,
    deviceId: deviceId ?? null,
  });
}

export async function cloudConversationsSetState(
  id: string,
  args: {
    state: ConversationState;
    snoozedUntil?: string | null;
    resolutionSummary?: string | null;
  },
): Promise<ConversationRow> {
  return call<ConversationRow>("cloud_conversations_set_state", {
    id,
    state: args.state,
    snoozedUntil: args.snoozedUntil ?? null,
    resolutionSummary: args.resolutionSummary ?? null,
  });
}

export async function cloudConversationsVerifyChain(id: string): Promise<VerifyChainResult> {
  return call<VerifyChainResult>("cloud_conversations_verify_chain", { id });
}

export async function cloudConversationsCreateFree(
  title: string,
  deviceId?: string | null,
): Promise<ConversationRow> {
  return call<ConversationRow>("cloud_conversations_create_free", {
    title,
    deviceId: deviceId ?? null,
  });
}

export async function cloudConversationsSubscribe(id: string): Promise<void> {
  await call<void>("cloud_conversations_subscribe", { id });
}

export async function cloudConversationsUnsubscribe(id: string): Promise<void> {
  await call<void>("cloud_conversations_unsubscribe", { id });
}

/** Tauri event emitted by the Rust SSE consumer (workspace + per-conv). */
export const EVT_CONVERSATION_EVENT = "conversation:event";

// ── Movie manifest (incident player) ────────────────────────────────

export interface MovieSessionPhase {
  sessionId: string;
  manifestUrl: string;
  durationMs: number | null;
  browser: string | null;
  os: string | null;
  viewport: unknown;
  rageClicks: { timestamp: number; selector: string; count: number }[];
  deadClicks: { timestamp: number; selector: string; mutationsAfter: number }[];
  webVitals: Record<string, { value: number; rating: "good" | "needs-improvement" | "poor" }>;
  urlsVisited: string[];
  frustrationScore: number | null;
  aiSummary: string | null;
  aiChapters: unknown;
  endUserEmailHash: string | null;
}

export interface MovieErrorPhase {
  title: string;
  severity: string;
  body: string | null;
  diagnosis: string | null;
  fingerprint: string | null;
  occurredAt: string;
}

export interface MovieFixPhase {
  remediationId: string;
  status: string;
  steps: unknown;
  fileChanges: unknown;
  confidenceScore: number | null;
  prUrl: string | null;
  branch: string | null;
}

export interface MoviePreviewPhase {
  publicSlug: string;
  screenshotUrl: string | null;
  predictionHtml: string | null;
  originalHtml: string | null;
  diffSummary: string | null;
  confidence: number | null;
}

export interface MovieManifest {
  alertId: string;
  inariHash: string;
  available: ("session" | "error" | "fix" | "preview")[];
  phases: {
    session?: MovieSessionPhase;
    error: MovieErrorPhase;
    fix?: MovieFixPhase;
    preview?: MoviePreviewPhase;
  };
  witness: {
    inariHash: string;
    eapReceiptId: string | null;
  };
}

export async function cloudGetMovieManifest(hash: string): Promise<MovieManifest> {
  return call<MovieManifest>("cloud_get_movie_manifest", { hash });
}

// ── Inari Guard — `/test <path>` slash command ──────────────────────

export interface TestGenFile {
  path: string;
  content: string;
}

export interface TestGenResult {
  sessionId: string;
  status: "ready" | "delivered" | "failed";
  costCents: number;
  durationMs: number;
  testFile?: TestGenFile | null;
  error?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
}

export type TestGenDelivery = "inline" | "pr" | "local";

/**
 * Inari Guard — generate tests for a file in the active project's
 * local clone. Reads from disk via `project_local_path_<projectId>`,
 * POSTs to /api/test-generation/start, returns the result.
 *
 * Called by the `/test <path>` slash command handler.
 */
export async function cloudGenerateTest(
  projectId: string,
  filePath: string,
  delivery: TestGenDelivery = "inline",
): Promise<TestGenResult> {
  return call<TestGenResult>("cloud_generate_test", {
    projectId,
    filePath,
    delivery,
  });
}

// ── AlertDetailPanel (`Cmd+\` sidecar) ────────────────────────────

/**
 * Full alert metadata for the AlertDetailPanel header + live banner.
 * Distinct from `cloudGetAlerts()` (the unread-list endpoint): this
 * returns ANY alert by id, including resolved/low-severity rows.
 *
 * Mirror of `AlertDetailResponse` in `web/app/api/desktop/alert/[id]/route.ts`.
 */
export interface AlertDetail {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  sourceIntegrations: string[];
  fingerprint: string | null;
  isResolved: boolean;
  resolvedAt: string | null;
  isRead: boolean;
  projectId: string;
  projectName: string;
  projectSlug: string | null;
  createdAt: string;
  lastEventAt: string;
}

/**
 * Single timeline event. Mirror of `TimelineEvent` in
 * `web/app/api/desktop/alert/[id]/timeline/route.ts`. The `kind`
 * field discriminates the renderer — each maps to an icon + style
 * in the panel.
 */
export type TimelineEventKind =
  | "alert_fired"
  | "comment"
  | "remediation_started"
  | "remediation_pr_opened"
  | "remediation_merged"
  | "remediation_completed"
  | "remediation_failed"
  | "ack"
  | "silence"
  | "resolve"
  | "reopen"
  | "escalate";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  at: string;
  text: string;
  witness?: string | null;
  actor?: string | null;
  meta?: Record<string, unknown>;
}

export interface AlertTimeline {
  events: TimelineEvent[];
}

export async function cloudGetAlertDetail(alertId: string): Promise<AlertDetail> {
  return call<AlertDetail>("cloud_get_alert_detail", { alertId });
}

export async function cloudGetAlertTimeline(alertId: string): Promise<AlertTimeline> {
  return call<AlertTimeline>("cloud_get_alert_timeline", { alertId });
}

/**
 * Quick action: resolve the alert. Same wire shape as silence — the
 * web side aliases the two via `silenceAlert(..., resolve=true)`.
 */
export async function cloudResolveAlert(args: { alertId?: string; project?: string } = {}): Promise<MutationResult> {
  return call<MutationResult>("cloud_resolve_alert", args);
}

// ── Visual Report (Inari Eye) ──────────────────────────────────────────────
//
// 1:1 with an alert that has source_integrations including 'user_report'.
// The AlertDetailPanel checks for that source and fetches this when
// present. Mirror of VisualReportDetailResponse in
// web/app/api/desktop/visual-report/[alertId]/route.ts.

export interface VisualReportEvidence {
  claim: string;
  type: string;
  source: string;
  quote: string;
}

export interface VisualReportHypothesis {
  hypothesis: string;
  score: number;
  rejected_because: string;
}

export interface VisualReportRootCause {
  file: string;
  line: number;
  function: string;
  causal_chain: string[];
}

export interface VisualReportDiagnosis {
  root_cause: VisualReportRootCause;
  evidence: VisualReportEvidence[];
  hypotheses_considered: VisualReportHypothesis[];
  confidence: number;
  unknowns: string[];
  recommended_fix_hint: string;
}

export interface VisualReportDetail {
  reportId: string;
  alertId: string;
  screenshotUrl: string;
  description: string;
  status: string;
  confidence: number | null;
  diagnosis: VisualReportDiagnosis | null;
  modelDiagnose: string | null;
  durationMs: number | null;
  costCents: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function cloudGetVisualReport(alertId: string): Promise<VisualReportDetail> {
  return call<VisualReportDetail>("cloud_get_visual_report", { alertId });
}
