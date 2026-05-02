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

// ── Auth helpers (re-exported from existing surface) ────────────────
//
// These are already implemented in `crate::ipc::auth` but exposed here so
// the dashboard panel doesn't need to import from two modules.

export interface AuthStatus {
  connected: boolean;
  api_url: string;
  watch_dir: string | null;
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
