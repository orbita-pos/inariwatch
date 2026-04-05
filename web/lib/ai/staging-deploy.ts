/**
 * InariWatch Staging Server Integration
 *
 * Deploys AI-generated fixes to an ephemeral staging environment for
 * browser-based verification before merging to production.
 *
 * Requires STAGING_SERVER_URL and STAGING_API_SECRET env vars.
 * If not configured, the staging gate is skipped (same pattern as EAP).
 */

import { db, substrateRecordings } from "@/lib/db";
import { eq, desc } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

export interface StagingDeployResult {
  id: string;
  status: string;
  url: string;
  expiresAt: string;
}

export interface StagingStatus {
  id: string;
  status: string;
  url: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  startedAt?: string;
  buildLogs?: string;
  error?: string;
}

export interface StagingVerifyResult {
  passed: boolean;
  results: { eventIndex: number; passed: boolean; statusCode: number; durationMs: number; error?: string }[];
  screenshots: string[];
  consoleErrors: string[];
  durationMs: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

function getConfig() {
  const url = process.env.STAGING_SERVER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!url || !secret) return null;
  // Enforce HTTPS to prevent credential leakage
  if (!url.startsWith("https://") && !url.startsWith("http://localhost")) return null;
  return { url: url.replace(/\/$/, ""), secret };
}

/** Returns true if the staging server is configured. */
export function isStagingConfigured(): boolean {
  return getConfig() !== null;
}

// ── API Client ──────────────────────────────────────────────────────────────

async function stagingFetch(path: string, init?: RequestInit): Promise<Response> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Staging server not configured");

  return fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.secret}`,
      ...init?.headers,
    },
  });
}

// ── Deploy ──────────────────────────────────────────────────────────────────

export async function deployStagingEnvironment(params: {
  deployId: string;
  repoUrl: string;
  branch: string;
  githubToken: string;
  framework?: string;
  envVars?: Record<string, string>;
  needsPostgres?: boolean;
  needsRedis?: boolean;
  ttlSeconds?: number;
  projectId?: string;
}): Promise<StagingDeployResult> {
  // Optionally include Substrate recording for verification later
  let substrateRecording: unknown = null;
  if (params.projectId) {
    try {
      const [rec] = await db
        .select({ events: substrateRecordings.events, context: substrateRecordings.context })
        .from(substrateRecordings)
        .where(eq(substrateRecordings.projectId, params.projectId))
        .orderBy(desc(substrateRecordings.createdAt))
        .limit(1);
      if (rec) substrateRecording = rec;
    } catch { /* non-blocking */ }
  }

  const res = await stagingFetch("/deploy", {
    method: "POST",
    body: JSON.stringify({
      id: params.deployId,
      repo_url: params.repoUrl,
      branch: params.branch,
      github_token: params.githubToken,
      framework: params.framework ?? "",
      env_vars: params.envVars ?? {},
      ttl_seconds: params.ttlSeconds ?? 300,
      needs_postgres: params.needsPostgres ?? false,
      needs_redis: params.needsRedis ?? false,
      substrate_recording: substrateRecording,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `staging deploy failed (${res.status})`);
  }

  const data = await res.json();
  return {
    id: data.id,
    status: data.status,
    url: data.url,
    expiresAt: data.expires_at,
  };
}

// ── Poll Status ─────────────────────────────────────────────────────────────

export async function pollStagingStatus(deployId: string): Promise<StagingStatus> {
  const res = await stagingFetch(`/status/${deployId}`);
  if (!res.ok) throw new Error(`status check failed (${res.status})`);
  return res.json();
}

/** Wait for staging to reach "running" state. Polls every 5s, max timeout. */
export async function waitForStagingReady(
  deployId: string,
  timeoutMs: number = 180_000
): Promise<StagingStatus> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await pollStagingStatus(deployId);

    if (status.status === "running") return status;
    if (status.status === "failed") throw new Error(status.error ?? "staging build failed");

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error("staging deploy timed out");
}

// ── Verify ──────────────────────────────────────────────────────────────────

export async function verifyStagingWithBot(
  deployId: string,
  substrateEvents?: { type: string; method: string; path: string; body?: unknown; expectedStatus?: number }[],
  uiActions?: { type: string; selector?: string; value?: string; url?: string; timestamp: number }[]
): Promise<StagingVerifyResult> {
  const events = substrateEvents ?? [
    // Default: basic health check
    { type: "http_request", method: "GET", path: "/", expectedStatus: 200 },
  ];

  const res = await stagingFetch(`/verify/${deployId}`, {
    method: "POST",
    body: JSON.stringify({
      substrate_events: events.map((e) => ({
        type: e.type,
        method: e.method,
        path: e.path,
        body: e.body,
        expected_status: e.expectedStatus ?? 0,
      })),
      assertions: [
        { type: "no_500_errors" },
        { type: "no_console_errors" },
      ],
      ui_actions: uiActions ?? [],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `verification failed (${res.status})`);
  }

  const data = await res.json();
  return {
    passed: data.passed,
    results: (data.results ?? []).map((r: Record<string, unknown>) => ({
      eventIndex: r.event_index as number,
      passed: r.passed as boolean,
      statusCode: r.status_code as number,
      durationMs: r.duration_ms as number,
      error: r.error as string | undefined,
    })),
    screenshots: data.screenshots ?? [],
    consoleErrors: data.console_errors ?? [],
    durationMs: data.duration_ms ?? 0,
  };
}

// ── Destroy ─────────────────────────────────────────────────────────────────

export async function destroyStagingEnvironment(deployId: string): Promise<void> {
  try {
    await stagingFetch(`/deploy/${deployId}`, { method: "DELETE" });
  } catch (e) {
    console.warn(`[staging] cleanup failed for ${deployId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Extract Substrate Events for Replay ─────────────────────────────────────

/** Extract UI actions (clicks, inputs, navigation) from session recording for bot replay. */
export function extractUIReplayActions(
  uiEvents: unknown[] | null
): { type: string; selector?: string; value?: string; url?: string; timestamp: number }[] {
  if (!uiEvents?.length) return [];

  const raw = uiEvents as Record<string, unknown>[];
  const actions: { type: string; selector?: string; value?: string; url?: string; timestamp: number }[] = [];

  for (const e of raw) {
    if (actions.length >= 50) break;
    const type = typeof e.type === "string" ? e.type : "";
    if (type !== "click" && type !== "input" && type !== "navigation") continue;
    const selector = typeof e.selector === "string" ? e.selector.slice(0, 200) : undefined;
    const value = type === "input" && typeof e.value === "string" ? e.value : undefined;
    const url = type === "navigation" && typeof e.url === "string" ? e.url : undefined;
    const timestamp = typeof e.timestamp === "number" ? e.timestamp : 0;
    actions.push({ type, selector, value, url, timestamp });
  }

  return actions;
}

/** Extract HTTP request events from a Substrate recording for bot replay. */
export function extractReplayEvents(
  recording: { events: unknown[] } | null
): { type: string; method: string; path: string; body?: unknown; expectedStatus?: number }[] {
  if (!recording?.events) return [];

  const events = recording.events as Record<string, unknown>[];
  return events
    .filter((e) => e.type === "http_request" || e.type === "http")
    .slice(0, 20)
    .map((e) => ({
      type: "http_request",
      method: String(e.method ?? "GET").toUpperCase(),
      path: String(e.url ?? e.path ?? "/"),
      body: e.body ?? undefined,
      expectedStatus: typeof e.statusCode === "number" ? e.statusCode as number : undefined,
    }))
    .filter((e) => e.path.startsWith("/"));
}
