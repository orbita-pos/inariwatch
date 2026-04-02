import { getToken, clearToken } from "./auth";
import { router } from "expo-router";
import type { Alert, AlertDetail } from "./types";

const API_BASE = "https://app.inariwatch.com";
const MCP_BASE = "https://mcp.inariwatch.com";

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

  const resp = await fetch(`${API_BASE}/api/mobile/alerts?${qs}`, {
    headers: await authHeaders(),
  });
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export async function fetchAlertDetail(id: string): Promise<AlertDetail> {
  const resp = await fetch(`${API_BASE}/api/mobile/alerts/${id}`, {
    headers: await authHeaders(),
  });
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

export async function fetchRemediation(id: string) {
  const resp = await fetch(`${API_BASE}/api/mobile/remediation/${id}`, {
    headers: await authHeaders(),
  });
  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ── MCP tool calls ──────────────────────────────────────────────────────────

export async function callMcpTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const resp = await fetch(MCP_BASE, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (resp.status === 401) await handleUnauthorized();
  if (!resp.ok) throw new Error(`MCP error: ${resp.status}`);
  const data = await resp.json();

  if (data.result?.isError) {
    throw new Error(data.result.content?.[0]?.text || "MCP tool error");
  }

  return data.result?.content?.[0]?.text || "";
}

// ── Convenience wrappers ────────────────────────────────────────────────────

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

// ── Push registration ───────────────────────────────────────────────────────

export async function registerPushToken(expoToken: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/api/mobile/push`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ expoToken }),
  });
  if (!resp.ok) throw new Error(`Push registration failed: ${resp.status}`);
}
