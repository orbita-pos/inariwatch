import { NextResponse } from "next/server";
import {
  authenticateMcp,
  hasScope,
  checkMcpRateLimit,
  logMcpCall,
  type McpUser,
} from "./auth";
import { TOOLS, COST_TIER_LIMITS, GLOBAL_RATE_LIMIT } from "./registry";
import { RESOURCES, readResource } from "./resources";
import { PROMPTS, expandPrompt } from "./prompts";
import { subscribe, unsubscribe } from "./subscriptions";
import { db, alerts, projects } from "@/lib/db";
import { eq, and } from "drizzle-orm";

// Tool implementations
import * as queryAlerts from "./tools/query-alerts";
import * as getStatus from "./tools/get-status";
import * as getUptime from "./tools/get-uptime";
import * as getBuildLogs from "./tools/get-build-logs";
import * as getSubstrateContext from "./tools/get-substrate-context";
import * as getRootCause from "./tools/get-root-cause";
import * as assessRisk from "./tools/assess-risk";
import * as getPostmortem from "./tools/get-postmortem";
import * as searchCommunityFixes from "./tools/search-community-fixes";
import * as triggerFix from "./tools/trigger-fix";
import * as rollbackDeploy from "./tools/rollback-deploy";
import * as rollbackVercel from "./tools/rollback-vercel";
import * as silenceAlert from "./tools/silence-alert";
import * as submitFeedback from "./tools/submit-feedback";
import * as runCheck from "./tools/run-check";
import * as askInari from "./tools/ask-inari";
import * as getErrorTrends from "./tools/get-error-trends";
import * as createUptimeMonitor from "./tools/create-uptime-monitor";
import * as runHealthCheck from "./tools/run-health-check";
import * as reproduceBug from "./tools/reproduce-bug";
import * as simulateFix from "./tools/simulate-fix";
import * as verifyRemediation from "./tools/verify-remediation";
import * as searchCodebase from "./tools/search-codebase";
import * as reindexCodebase from "./tools/reindex-codebase";

type ToolHandler = {
  execute: (args: Record<string, unknown>, user: McpUser) => Promise<string>;
  executeStream?: (args: Record<string, unknown>, user: McpUser, emit: (event: string, data: unknown) => void) => Promise<void>;
};

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  query_alerts: queryAlerts,
  get_status: getStatus,
  get_uptime: getUptime,
  get_build_logs: getBuildLogs,
  get_substrate_context: getSubstrateContext,
  get_root_cause: getRootCause,
  assess_risk: assessRisk,
  get_postmortem: getPostmortem,
  search_community_fixes: searchCommunityFixes,
  trigger_fix: triggerFix,
  rollback_deploy: rollbackDeploy,
  rollback_vercel: rollbackVercel, // legacy alias — same execute path
  silence_alert: silenceAlert,
  submit_feedback: submitFeedback,
  run_check: runCheck,
  ask_inari: askInari,
  get_error_trends: getErrorTrends,
  create_uptime_monitor: createUptimeMonitor,
  run_health_check: runHealthCheck,
  reproduce_bug: reproduceBug,
  simulate_fix: simulateFix,
  verify_remediation: verifyRemediation,
  search_codebase: searchCodebase,
  reindex_codebase: reindexCodebase,
};

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "inariwatch";
const SERVER_VERSION = "1.0.0";

function jsonrpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonrpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Streamable HTTP: POST handles all JSON-RPC messages ──────────────────────

export async function POST(request: Request) {
  // Auth
  const user = await authenticateMcp(request);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized. Provide Authorization: Bearer <inari_token>" },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  // Rate limit
  const rl = await checkMcpRateLimit(user.tokenId);
  if (!rl.allowed) {
    return NextResponse.json(
      jsonrpcError(null, -32000, `Rate limited. Retry in ${rl.retryAfterSeconds}s.`),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Retry-After": String(rl.retryAfterSeconds ?? 60),
        },
      }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      jsonrpcError(null, -32700, "Parse error"),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const method = body.method as string;
  const id = body.id;
  const params = (body.params ?? {}) as Record<string, unknown>;

  // ── initialize ──
  if (method === "initialize") {
    return NextResponse.json(
      jsonrpc(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: { subscribe: true }, prompts: {}, sampling: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      { headers: CORS_HEADERS }
    );
  }

  // ── ping ──
  if (method === "ping") {
    return NextResponse.json(jsonrpc(id, {}), { headers: CORS_HEADERS });
  }

  // ── resources/list ──
  if (method === "resources/list") {
    return NextResponse.json(
      jsonrpc(id, { resources: RESOURCES }),
      { headers: CORS_HEADERS }
    );
  }

  // ── resources/read ──
  if (method === "resources/read") {
    const uri = params.uri as string;
    if (!uri) {
      return NextResponse.json(
        jsonrpc(id, { contents: [], isError: true }),
        { headers: CORS_HEADERS }
      );
    }
    const result = await readResource(uri, user);
    if (!result) {
      return NextResponse.json(
        jsonrpc(id, {
          contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }],
          isError: true,
        }),
        { headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(jsonrpc(id, result), { headers: CORS_HEADERS });
  }

  // ── resources/subscribe ──
  if (method === "resources/subscribe") {
    const uri = params.uri as string;
    if (!uri) return NextResponse.json(jsonrpcError(id, -32602, "uri required"), { headers: CORS_HEADERS });
    const validUris = RESOURCES.map((r) => r.uri);
    if (!validUris.includes(uri)) return NextResponse.json(jsonrpcError(id, -32602, `Unknown resource: ${uri}`), { headers: CORS_HEADERS });
    subscribe(user.tokenId, uri);
    return NextResponse.json(jsonrpc(id, {}), { headers: CORS_HEADERS });
  }

  // ── resources/unsubscribe ──
  if (method === "resources/unsubscribe") {
    const uri = params.uri as string;
    if (uri) unsubscribe(user.tokenId, uri);
    return NextResponse.json(jsonrpc(id, {}), { headers: CORS_HEADERS });
  }

  // ── prompts/list ──
  if (method === "prompts/list") {
    return NextResponse.json(
      jsonrpc(id, { prompts: PROMPTS }),
      { headers: CORS_HEADERS }
    );
  }

  // ── prompts/get ──
  if (method === "prompts/get") {
    const promptName = params.name as string;
    const promptArgs = (params.arguments ?? {}) as Record<string, string>;
    const result = expandPrompt(promptName, promptArgs);
    if (!result) {
      return NextResponse.json(
        jsonrpcError(id, -32602, `Unknown prompt: ${promptName}`),
        { headers: CORS_HEADERS }
      );
    }
    return NextResponse.json(jsonrpc(id, result), { headers: CORS_HEADERS });
  }

  // ── sampling/createMessage ──
  if (method === "sampling/createMessage") {
    // Scope check: requires write
    if (!hasScope(user.scopes, "write")) {
      return NextResponse.json(
        jsonrpcError(id, -32600, "Permission denied: sampling/createMessage requires write scope."),
        { headers: CORS_HEADERS }
      );
    }

    const context = params.context as Record<string, string> | undefined;
    const content = params.content as { text?: string } | undefined;
    const analysis = content?.text;
    const alertId = context?.alert_id;

    if (!analysis) {
      return NextResponse.json(
        jsonrpcError(id, -32602, "content.text is required"),
        { headers: CORS_HEADERS }
      );
    }

    // For alert-based tools (get_root_cause, simulate_fix), persist the analysis
    if (alertId) {
      const [alert] = await db.select({ id: alerts.id, projectId: alerts.projectId }).from(alerts).where(eq(alerts.id, alertId)).limit(1);
      if (!alert) {
        return NextResponse.json(jsonrpcError(id, -32602, "Alert not found"), { headers: CORS_HEADERS });
      }
      const [proj] = await db.select({ id: projects.id }).from(projects).where(
        and(eq(projects.id, alert.projectId), eq(projects.userId, user.userId))
      ).limit(1);
      if (!proj) {
        return NextResponse.json(jsonrpcError(id, -32600, "Alert does not belong to your projects."), { headers: CORS_HEADERS });
      }

      await db.update(alerts).set({ aiReasoning: analysis }).where(eq(alerts.id, alertId));
    }

    // For non-alert tools (ask_inari, assess_risk) — acknowledge without persistence
    return NextResponse.json(
      jsonrpc(id, {
        role: "assistant",
        content: { type: "text", text: alertId ? "Analysis stored successfully." : "Acknowledged." },
        model: "client-provided",
      }),
      { headers: CORS_HEADERS }
    );
  }

  // ── tools/list ──
  if (method === "tools/list") {
    const available = TOOLS.filter((t) => hasScope(user.scopes, t.scope));

    return NextResponse.json(
      jsonrpc(id, {
        tools: available.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      }),
      { headers: CORS_HEADERS }
    );
  }

  // ── tools/call ──
  if (method === "tools/call") {
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      return NextResponse.json(
        jsonrpc(id, {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        }),
        { headers: CORS_HEADERS }
      );
    }

    // Check scope
    const toolDef = TOOLS.find((t) => t.name === toolName);
    if (toolDef && !hasScope(user.scopes, toolDef.scope)) {
      return NextResponse.json(
        jsonrpc(id, {
          content: [
            {
              type: "text",
              text: `Permission denied: ${toolName} requires "${toolDef.scope}" scope. Your scopes: [${user.scopes.join(", ")}]`,
            },
          ],
          isError: true,
        }),
        { headers: CORS_HEADERS }
      );
    }

    // ── Global rate limiting (1000 calls/hour — protection, not paywall) ──
    if (toolDef) {
      const globalRl = await checkMcpRateLimit(`${user.tokenId}:global`, GLOBAL_RATE_LIMIT);
      if (!globalRl.allowed) {
        return NextResponse.json(
          jsonrpc(id, {
            content: [{
              type: "text",
              text: `Rate limited (1000 calls/hour). Retry in ${globalRl.retryAfterSeconds}s.`,
            }],
            isError: true,
          }),
          { status: 429, headers: { ...CORS_HEADERS, "Retry-After": String(globalRl.retryAfterSeconds ?? 60) } }
        );
      }
    }

    // ── Per-tool rate limiting ──
    if (toolDef) {
      const tierLimits = COST_TIER_LIMITS[toolDef.costTier];
      const toolRl = await checkMcpRateLimit(
        `${user.tokenId}:${toolDef.costTier}`,
        tierLimits
      );
      if (!toolRl.allowed) {
        return NextResponse.json(
          jsonrpc(id, {
            content: [{
              type: "text",
              text: `Rate limited: ${toolName} (${toolDef.costTier} tier) allows ${tierLimits.max} calls/minute. Retry in ${toolRl.retryAfterSeconds}s.`,
            }],
            isError: true,
          }),
          { status: 429, headers: { ...CORS_HEADERS, "Retry-After": String(toolRl.retryAfterSeconds ?? 60) } }
        );
      }
    }

    // ── SSE streaming path (for tools that support it) ──
    const shouldStream =
      handler.executeStream &&
      toolName === "trigger_fix" &&
      toolArgs.dry_run !== true;

    if (shouldStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          function emit(event: string, data: unknown) {
            const msg = JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/tools/progress",
              params: { tool: toolName, event, data },
            });
            controller.enqueue(encoder.encode(`event: message\ndata: ${msg}\n\n`));
          }
          try {
            await handler.executeStream!(toolArgs, user, emit);
            const finalMsg = JSON.stringify(
              jsonrpc(id, {
                content: [{ type: "text", text: "Remediation completed. See SSE events for details." }],
              })
            );
            controller.enqueue(encoder.encode(`event: message\ndata: ${finalMsg}\n\n`));
          } catch (e) {
            const errMsg = JSON.stringify(
              jsonrpc(id, {
                content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : "unknown"}` }],
                isError: true,
              })
            );
            controller.enqueue(encoder.encode(`event: message\ndata: ${errMsg}\n\n`));
          }
          controller.close();
        },
      });

      logMcpCall(user.userId, toolName, toolArgs, { ok: true, latencyMs: 0 });

      return new Response(stream, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // ── Normal (non-streaming) path ──
    const start = Date.now();
    try {
      const result = await handler.execute(toolArgs, user);
      const latencyMs = Date.now() - start;

      // Audit log (fire-and-forget)
      logMcpCall(user.userId, toolName, toolArgs, { ok: true, latencyMs });

      return NextResponse.json(
        jsonrpc(id, { content: [{ type: "text", text: result }] }),
        { headers: CORS_HEADERS }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Internal error";
      const latencyMs = Date.now() - start;

      // Audit log error (fire-and-forget)
      logMcpCall(user.userId, toolName, toolArgs, {
        ok: false,
        latencyMs,
        error: msg,
      });

      return NextResponse.json(
        jsonrpc(id, {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        }),
        { headers: CORS_HEADERS }
      );
    }
  }

  // ── notifications (no response) ──
  if (method?.startsWith("notifications/")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── unknown method ──
  return NextResponse.json(
    jsonrpcError(id, -32601, `Method not found: ${method}`),
    { status: 400, headers: CORS_HEADERS }
  );
}

// ── OPTIONS for CORS ──
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
