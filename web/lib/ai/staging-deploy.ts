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
  results: { eventIndex: number; passed: boolean; statusCode: number; durationMs: number; error?: string; missingBodyKeys?: string[] }[];
  screenshots: string[];
  consoleErrors: string[];
  durationMs: number;
  aiVisual?: { passed: boolean; issues: string };
  /** Selector replay stats from UI actions */
  selectorReplay?: {
    actionsAttempted: number;
    actionsSucceeded: number;
    actionsFailed: { selector: string; error: string }[];
    selectorReplayComplete: boolean;
  };
  /** Deep response body diffs (error = blocking, warning = informational) */
  bodyDiffs?: DiffEntry[];
}

export interface DiffEntry {
  path: string;
  expected: string;
  actual: string;
  severity: "error" | "warning";
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
    signal: init?.signal ?? AbortSignal.timeout(15_000),
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
  // The Go staging server returns snake_case (build_logs, created_at, ...).
  // The interface uses camelCase, so we normalize here once rather than
  // forcing every caller to remember the shape drift.
  const raw = (await res.json()) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    url: String(raw.url ?? ""),
    port: Number(raw.port ?? 0),
    createdAt: String(raw.created_at ?? raw.createdAt ?? ""),
    expiresAt: String(raw.expires_at ?? raw.expiresAt ?? ""),
    startedAt: (raw.started_at ?? raw.startedAt) as string | undefined,
    buildLogs: (raw.build_logs ?? raw.buildLogs) as string | undefined,
    error: raw.error as string | undefined,
  };
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
    if (status.status === "failed") {
      const logs = status.buildLogs ? `\nBuild logs:\n${status.buildLogs.slice(-2000)}` : "";
      throw new Error((status.error ?? "staging build failed") + logs);
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error("staging deploy timed out");
}

// ── Verify ──────────────────────────────────────────────────────────────────

export async function verifyStagingWithBot(
  deployId: string,
  substrateEvents?: { type: string; method: string; path: string; body?: unknown; expectedStatus?: number; expectedBodyKeys?: string[] }[],
  uiActions?: { type: string; selector?: string; value?: string; url?: string; timestamp: number }[]
): Promise<StagingVerifyResult> {
  const events = substrateEvents ?? [
    // Default: basic health check
    { type: "http_request", method: "GET", path: "/", expectedStatus: 200 },
  ];

  // Strict assertions only when we have real replay events (Substrate recording)
  // Default health check is lenient — console errors are normal in Next.js/React apps
  const hasReplayData = !!substrateEvents?.length;
  const assertions = hasReplayData
    ? [{ type: "no_500_errors" }, { type: "no_console_errors" }]
    : [{ type: "no_500_errors" }];

  const res = await stagingFetch(`/verify/${deployId}`, {
    method: "POST",
    body: JSON.stringify({
      substrate_events: events.map((e) => ({
        type: e.type,
        method: e.method,
        path: e.path,
        body: e.body,
        expected_status: e.expectedStatus ?? 0,
        expected_body_keys: e.expectedBodyKeys ?? [],
      })),
      assertions,
      ui_actions: uiActions ?? [],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `verification failed (${res.status})`);
  }

  const data = await res.json();

  // Parse selector replay stats from bot results
  const uiResults = (data.results ?? []).filter((r: Record<string, unknown>) => {
    const idx = r.event_index as number;
    return typeof idx === "number" && idx < (uiActions?.length ?? 0);
  });
  const selectorReplay = uiActions?.length ? {
    actionsAttempted: uiActions.length,
    actionsSucceeded: uiResults.filter((r: Record<string, unknown>) => r.passed).length,
    actionsFailed: uiResults
      .filter((r: Record<string, unknown>) => !r.passed && r.error)
      .map((r: Record<string, unknown>) => ({ selector: "unknown", error: r.error as string })),
    selectorReplayComplete: uiResults.every((r: Record<string, unknown>) => r.passed),
  } : undefined;

  return {
    passed: data.passed,
    results: (data.results ?? []).map((r: Record<string, unknown>) => ({
      eventIndex: r.event_index as number,
      passed: r.passed as boolean,
      statusCode: r.status_code as number,
      durationMs: r.duration_ms as number,
      error: r.error as string | undefined,
      missingBodyKeys: r.missing_body_keys as string[] | undefined,
    })),
    screenshots: data.screenshots ?? [],
    consoleErrors: data.console_errors ?? [],
    durationMs: data.duration_ms ?? 0,
    aiVisual: data.ai_visual ? { passed: data.ai_visual.passed, issues: data.ai_visual.issues ?? "" } : undefined,
    selectorReplay,
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

// ── Deep Response Body Diffing ─────────────────────────────────────────────

const MAX_DIFF_DEPTH = 4;
const MAX_KEYS_PER_LEVEL = 50;
const MAX_BODY_SIZE = 100_000; // 100KB

/**
 * Recursively compare expected vs actual JSON response bodies.
 * Reports missing keys, type mismatches, null where value existed, empty arrays.
 */
export function deepDiffResponseBody(
  expected: unknown,
  actual: unknown,
  path = "$",
  depth = 0,
): DiffEntry[] {
  if (depth > MAX_DIFF_DEPTH) return [];
  const diffs: DiffEntry[] = [];

  // Both null/undefined — ok
  if (expected == null && actual == null) return [];

  // Expected has value, actual is null/undefined
  if (expected != null && actual == null) {
    diffs.push({ path, expected: typeLabel(expected), actual: "null", severity: "warning" });
    return diffs;
  }

  // Type mismatch
  if (typeof expected !== typeof actual) {
    // null → value is fine (data populated), value → null is warning
    if (actual == null) {
      diffs.push({ path, expected: typeLabel(expected), actual: "null", severity: "warning" });
    } else {
      diffs.push({ path, expected: typeLabel(expected), actual: typeLabel(actual), severity: "error" });
    }
    return diffs;
  }

  // Array comparison
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length > 0 && actual.length === 0) {
      diffs.push({ path, expected: `array[${expected.length}]`, actual: "array[0]", severity: "warning" });
    }
    return diffs; // Don't diff individual array items — data changes between runs
  }

  // Object comparison — recurse into keys
  if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const keys = Object.keys(expectedObj).slice(0, MAX_KEYS_PER_LEVEL);

    for (const key of keys) {
      if (!(key in actualObj)) {
        diffs.push({ path: `${path}.${key}`, expected: typeLabel(expectedObj[key]), actual: "missing", severity: "error" });
      } else {
        diffs.push(...deepDiffResponseBody(expectedObj[key], actualObj[key], `${path}.${key}`, depth + 1));
      }
    }
    return diffs;
  }

  // Primitive values — don't diff (data changes between runs, only structure matters)
  return diffs;
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/** Check if a body is small enough for deep diffing */
function isSmallEnoughForDeepDiff(body: unknown): boolean {
  try {
    return JSON.stringify(body).length <= MAX_BODY_SIZE;
  } catch { return false; }
}

// ── Extract Events ────────────────────────────────────────────────────────────

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

/** Extracted replay event with optional expected response body for deep diffing */
export interface ReplayEvent {
  type: string;
  method: string;
  path: string;
  body?: unknown;
  expectedStatus?: number;
  expectedBodyKeys?: string[];
  /** Full expected response body for deep diffing (only if small enough) */
  expectedResponseBody?: unknown;
}

/** Extract HTTP request events from a Substrate recording for bot replay. */
export function extractReplayEvents(
  recording: { events: unknown[] } | null
): ReplayEvent[] {
  if (!recording?.events) return [];

  const events = recording.events as Record<string, unknown>[];
  return events
    .filter((e) => e.type === "http_request" || e.type === "http")
    .slice(0, 20)
    .map((e) => {
      let expectedBodyKeys: string[] | undefined;
      let expectedResponseBody: unknown | undefined;
      const responseBody = e.responseBody ?? e.response_body;
      if (responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)) {
        expectedBodyKeys = Object.keys(responseBody as Record<string, unknown>).slice(0, 10);
        // Include full body for deep diffing if small enough
        if (isSmallEnoughForDeepDiff(responseBody)) {
          expectedResponseBody = responseBody;
        }
      }
      return {
        type: "http_request",
        method: String(e.method ?? "GET").toUpperCase(),
        path: String(e.url ?? e.path ?? "/"),
        body: e.body ?? undefined,
        expectedStatus: typeof e.statusCode === "number" ? e.statusCode as number : undefined,
        expectedBodyKeys,
        expectedResponseBody,
      };
    })
    .filter((e) => e.path.startsWith("/"));
}
