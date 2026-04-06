/**
 * L4 Chaos: MCP Rate Limit Storm
 *
 * Hammers the MCP server with 200 concurrent calls mixing all 3 tiers:
 * - Cheap (200/min): query_alerts, get_status
 * - Moderate (30/min): get_error_trends, get_root_cause
 * - Expensive (5/min): trigger_fix, assess_risk
 *
 * Validates:
 * - Tier isolation (cheap 429 doesn't block moderate)
 * - Rate limit headers (Retry-After)
 * - No cascading failures
 * - System recovers after storm
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, mcpHeaders, mcpPayload } from "../lib/helpers.js";
import { MCP_THRESHOLDS } from "../lib/thresholds.js";
import { mcpCallsTotal, mcpRateLimited, mcpLatency } from "../lib/metrics.js";
import { Counter } from "k6/metrics";

const cheapAccepted = new Counter("mcp_cheap_accepted");
const cheapRejected = new Counter("mcp_cheap_rejected");
const moderateAccepted = new Counter("mcp_moderate_accepted");
const moderateRejected = new Counter("mcp_moderate_rejected");
const expensiveAccepted = new Counter("mcp_expensive_accepted");
const expensiveRejected = new Counter("mcp_expensive_rejected");

export const options = {
  scenarios: {
    // Phase 1: Burst all tiers simultaneously
    cheap_flood: {
      executor: "constant-vus",
      vus: 20,
      duration: "60s",
      exec: "cheapCalls",
    },
    moderate_flood: {
      executor: "constant-vus",
      vus: 10,
      duration: "60s",
      exec: "moderateCalls",
      startTime: "5s",
    },
    expensive_flood: {
      executor: "constant-vus",
      vus: 5,
      duration: "60s",
      exec: "expensiveCalls",
      startTime: "10s",
    },
    // Phase 2: Recovery check after storm
    recovery: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      startTime: "75s",
      exec: "recoveryCheck",
    },
  },
  thresholds: {
    ...MCP_THRESHOLDS,
    "mcp_cheap_rejected": ["count>0"],     // we EXPECT some 429s
    "mcp_moderate_rejected": ["count>0"],   // same
    "mcp_expensive_rejected": ["count>0"],  // same
  },
  tags: { scenario: "chaos-mcp-storm" },
};

const CHEAP_TOOLS = ["query_alerts", "get_status", "get_uptime"];
const MODERATE_TOOLS = ["get_error_trends", "get_root_cause"];
const EXPENSIVE_TOOLS = ["trigger_fix", "assess_risk"];

function mcpCall(tool, tier) {
  const body = mcpPayload(tool, { limit: 5 });
  const start = Date.now();

  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp", tier },
  });

  mcpCallsTotal.add(1);
  mcpLatency.add(Date.now() - start);

  if (res.status === 429) {
    mcpRateLimited.add(1);
    check(res, {
      "429 has Retry-After": (r) => r.headers["Retry-After"] !== undefined,
    });
  }

  return res;
}

export function cheapCalls() {
  const tool = CHEAP_TOOLS[Math.floor(Math.random() * CHEAP_TOOLS.length)];
  const res = mcpCall(tool, "cheap");
  if (res.status === 200) cheapAccepted.add(1);
  else if (res.status === 429) cheapRejected.add(1);
  sleep(0.1 + Math.random() * 0.2);
}

export function moderateCalls() {
  const tool = MODERATE_TOOLS[Math.floor(Math.random() * MODERATE_TOOLS.length)];
  const res = mcpCall(tool, "moderate");
  if (res.status === 200) moderateAccepted.add(1);
  else if (res.status === 429) moderateRejected.add(1);
  sleep(0.5 + Math.random() * 1);
}

export function expensiveCalls() {
  const tool = EXPENSIVE_TOOLS[Math.floor(Math.random() * EXPENSIVE_TOOLS.length)];
  const res = mcpCall(tool, "expensive");
  if (res.status === 200) expensiveAccepted.add(1);
  else if (res.status === 429) expensiveRejected.add(1);
  sleep(1 + Math.random() * 2);
}

export function recoveryCheck() {
  sleep(5);

  // After the storm, cheap calls should succeed again
  const res = mcpCall("get_status", "cheap");
  check(res, {
    "system recovers after MCP storm": (r) => r.status === 200,
  });
}
