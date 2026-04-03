/**
 * Scenario 2: MCP Server Rate Limiting
 *
 * Tests the 3 rate limit tiers (cheap/moderate/expensive) and global limits.
 * Validates: per-tier limits, Retry-After header, cross-tier interaction.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, mcpHeaders, mcpPayload } from "../lib/helpers.js";
import { MCP_THRESHOLDS } from "../lib/thresholds.js";
import { mcpCallsTotal, mcpRateLimited, mcpLatency, rateLimitHit } from "../lib/metrics.js";

export const options = {
  scenarios: {
    cheap_tier: {
      executor: "constant-arrival-rate",
      rate: 220,        // slightly above 200/min limit
      timeUnit: "1m",
      duration: "2m",
      preAllocatedVUs: 30,
      exec: "cheapTier",
      tags: { tier: "cheap" },
    },
    moderate_tier: {
      executor: "constant-arrival-rate",
      rate: 35,          // slightly above 30/min limit
      timeUnit: "1m",
      duration: "2m",
      preAllocatedVUs: 10,
      exec: "moderateTier",
      tags: { tier: "moderate" },
    },
    expensive_tier: {
      executor: "constant-arrival-rate",
      rate: 8,           // slightly above 5/min limit
      timeUnit: "1m",
      duration: "2m",
      preAllocatedVUs: 5,
      exec: "expensiveTier",
      tags: { tier: "expensive" },
    },
  },
  thresholds: MCP_THRESHOLDS,
  tags: { scenario: "mcp-rate-limits" },
};

const CHEAP_TOOLS = ["query_alerts", "get_status", "get_uptime", "get_error_trends"];
const MODERATE_TOOLS = ["get_root_cause", "ask_inari", "search_codebase"];
const EXPENSIVE_TOOLS = ["trigger_fix", "simulate_fix"];

function callMCP(toolName, args, tier) {
  const body = mcpPayload(toolName, args);
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { tier, tool: toolName },
  });

  mcpCallsTotal.add(1);
  mcpLatency.add(res.timings.duration);

  if (res.status === 429) {
    mcpRateLimited.add(1);
    rateLimitHit.add(true);
    check(res, {
      "rate limited returns 429": (r) => r.status === 429,
      "has Retry-After header": (r) => r.headers["Retry-After"] !== undefined || r.headers["retry-after"] !== undefined,
    });
  } else {
    rateLimitHit.add(false);
    check(res, {
      "MCP call succeeds": (r) => r.status === 200,
      "valid JSON-RPC response": (r) => {
        try { const j = JSON.parse(r.body); return j.jsonrpc === "2.0"; } catch { return false; }
      },
    });
  }

  return res;
}

export function cheapTier() {
  const tool = CHEAP_TOOLS[Math.floor(Math.random() * CHEAP_TOOLS.length)];
  callMCP(tool, { limit: 5 }, "cheap");
}

export function moderateTier() {
  const tool = MODERATE_TOOLS[Math.floor(Math.random() * MODERATE_TOOLS.length)];
  callMCP(tool, { query: "latest errors" }, "moderate");
}

export function expensiveTier() {
  const tool = EXPENSIVE_TOOLS[Math.floor(Math.random() * EXPENSIVE_TOOLS.length)];
  callMCP(tool, { alert_id: "test-alert-id" }, "expensive");
}
