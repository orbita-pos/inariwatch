import { getToken, clearToken } from "./auth";
import { router } from "expo-router";
import type { Alert, AlertDetail } from "./types";

const API_BASE = "https://app.inariwatch.com";
const MCP_BASE = "https://mcp.inariwatch.com";

// ── Fetch with timeout ─────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("La solicitud agoto el tiempo de espera");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const REST_TIMEOUT = 15_000;
const MCP_TIMEOUT = 30_000;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Handle 401 — clear stale token and redirect to login */
async function handleUnauthorized(): Promise<never> {
  await clearToken();
  router.replace("/login");
  throw new Error("Session expired. Please sign in again.");
}

// ── REST endpoints (mobile-specific) ────────────────────────────────────────

export async function fetchAlerts(params?: {
  severity?: string;
  since?: string;
  limit?: number;
  offset?: number;
}): Promise<{ alerts: Alert[]; unreadCount: number }> {
  const qs = new URLSearchParams();
  if (params?.severity) qs.set("severity", params.severity);
  if (params?.since) qs.set("since", params.since);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));

  const resp = await fetchWithTimeout(
    `${API_BASE}/api/mobile/alerts?${qs}`,
    { headers: await authHeaders() },
    REST_TIMEOUT
  );
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export async function fetchAlertDetail(id: string): Promise<AlertDetail> {
  const resp = await fetchWithTimeout(
    `${API_BASE}/api/mobile/alerts/${id}`,
    { headers: await authHeaders() },
    REST_TIMEOUT
  );
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export async function fetchRemediation(id: string) {
  const resp = await fetchWithTimeout(
    `${API_BASE}/api/mobile/remediation/${id}`,
    { headers: await authHeaders() },
    REST_TIMEOUT
  );
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ── MCP tool calls ──────────────────────────────────────────────────────────

export async function callMcpTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const resp = await fetchWithTimeout(
    MCP_BASE,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    MCP_TIMEOUT
  );

  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`MCP error: ${resp.status}`);
  const data = await resp.json();

  if (data.result?.isError) {
    throw new Error(data.result.content?.[0]?.text || "MCP tool error");
  }

  return data.result?.content?.[0]?.text || "";
}

// ── MCP wrappers (existing) ────────────────────────────────────────────────

export async function ackAlert(alertId: string): Promise<string> {
  return callMcpTool("silence_alert", { alert_id: alertId, resolve: false });
}

export async function resolveAlert(alertId: string): Promise<string> {
  return callMcpTool("silence_alert", { alert_id: alertId, resolve: true });
}

export async function triggerFix(alertId: string): Promise<string> {
  return callMcpTool("trigger_fix", { alert_id: alertId });
}

export async function askInari(question: string): Promise<string> {
  return callMcpTool("ask_inari", { question });
}

export async function getUptime(): Promise<string> {
  return callMcpTool("get_uptime");
}

export async function getStatus(): Promise<string> {
  return callMcpTool("get_status");
}

export async function getErrorTrends(days?: number): Promise<string> {
  return callMcpTool("get_error_trends", { days: days ?? 7 });
}

// ── MCP wrappers (new — Phase 1+2 tools) ──────────────────────────────────

export async function queryAlertsMcp(params?: {
  project?: string;
  severity?: string;
  limit?: number;
}): Promise<string> {
  return callMcpTool("query_alerts", params ?? {});
}

export async function getBuildLogs(params?: {
  project?: string;
  deployment_id?: string;
}): Promise<string> {
  return callMcpTool("get_build_logs", params ?? {});
}

export async function getSubstrateContext(alertId: string): Promise<string> {
  return callMcpTool("get_substrate_context", { alert_id: alertId });
}

export async function getRootCause(alertId: string): Promise<string> {
  return callMcpTool("get_root_cause", { alert_id: alertId });
}

export async function getPostmortem(alertId: string): Promise<string> {
  return callMcpTool("get_postmortem", { alert_id: alertId });
}

export async function searchCommunityFixes(
  query: string,
  limit?: number
): Promise<string> {
  return callMcpTool("search_community_fixes", { query, ...(limit ? { limit } : {}) });
}

export async function rollbackVercel(
  project: string,
  deploymentId?: string
): Promise<string> {
  return callMcpTool("rollback_vercel", {
    project,
    ...(deploymentId ? { deployment_id: deploymentId } : {}),
  });
}

export async function submitFeedback(
  sessionId: string,
  worked: boolean
): Promise<string> {
  return callMcpTool("submit_feedback", { session_id: sessionId, worked });
}

export async function simulateFix(
  alertId: string,
  fixDescription: string
): Promise<string> {
  return callMcpTool("simulate_fix", {
    alert_id: alertId,
    fix_description: fixDescription,
  });
}

export async function verifyRemediation(alertId: string): Promise<string> {
  return callMcpTool("verify_remediation", { alert_id: alertId });
}

export async function reproduceBug(
  alertId: string,
  verbose?: boolean
): Promise<string> {
  return callMcpTool("reproduce_bug", {
    alert_id: alertId,
    ...(verbose ? { verbose } : {}),
  });
}

export async function runHealthCheck(): Promise<string> {
  return callMcpTool("run_health_check");
}

export async function runCheck(project?: string): Promise<string> {
  return callMcpTool("run_check", project ? { project } : {});
}

export async function createUptimeMonitor(params: {
  url: string;
  project: string;
  name?: string;
  interval_sec?: number;
  expected_status?: number;
}): Promise<string> {
  return callMcpTool("create_uptime_monitor", params);
}

export async function assessRisk(
  project: string,
  prNumber: number
): Promise<string> {
  return callMcpTool("assess_risk", { project, pr_number: prNumber });
}

export async function searchCodebase(
  query: string,
  project?: string,
  limit?: number
): Promise<string> {
  return callMcpTool("search_codebase", {
    query,
    ...(project ? { project } : {}),
    ...(limit ? { limit } : {}),
  });
}

export async function reindexCodebase(project: string): Promise<string> {
  return callMcpTool("reindex_codebase", { project });
}

// ── Push registration ───────────────────────────────────────────────────────

export async function registerPushToken(expoToken: string): Promise<void> {
  const resp = await fetchWithTimeout(
    `${API_BASE}/api/mobile/push`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ expoToken }),
    },
    REST_TIMEOUT
  );
  if (!resp.ok) throw new Error(`Push registration failed: ${resp.status}`);
}
