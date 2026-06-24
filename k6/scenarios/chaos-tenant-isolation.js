/**
 * L4 Chaos: Multi-Tenant Isolation
 *
 * Floods one workspace ("attacker") with 200 rapid webhooks while
 * simultaneously measuring another workspace's ("victim") response time.
 *
 * Validates:
 * - Victim latency stays under threshold despite attacker flood
 * - Rate limiting isolates per-IP, not globally
 * - DB connection pool doesn't starve victim queries
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import crypto from "k6/crypto";
import { BASE_URL, CAPTURE_SECRET, INTEGRATION_ID, mcpHeaders, mcpPayload } from "../lib/helpers.js";
import { TENANT_THRESHOLDS } from "../lib/thresholds.js";
import { tenantIsolationDelta } from "../lib/metrics.js";
import { Trend, Counter } from "k6/metrics";

const attackerAccepted = new Counter("attacker_accepted");
const attackerRejected = new Counter("attacker_rejected");
const victimLatency = new Trend("victim_latency", true);
const victimErrors = new Counter("victim_errors");

export const options = {
  scenarios: {
    // Attacker: flood webhooks from one IP
    attacker_flood: {
      executor: "constant-arrival-rate",
      rate: 100,               // 100 req/sec
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 50,
      exec: "attackerFlood",
    },
    // Victim: measure latency of normal operations
    victim_baseline: {
      executor: "constant-vus",
      vus: 3,
      duration: "30s",
      exec: "victimOperations",
    },
    // Post-flood: verify victim recovers
    post_flood: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 5,
      startTime: "35s",
      exec: "victimOperations",
    },
  },
  thresholds: {
    ...TENANT_THRESHOLDS,
    "victim_latency": ["p(95)<2000"],   // victim p95 under 2s
    "victim_errors": ["count<3"],       // almost no errors for victim
  },
  tags: { scenario: "chaos-tenant-isolation" },
};

export function attackerFlood() {
  const title = `chaos-attacker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `Flood alert: ${title}`,
    severity: "info",
    timestamp: new Date().toISOString(),
    runtime: "nodejs",
    tags: { test: "chaos-tenant-isolation", role: "attacker" },
  });

  const sig = crypto.hmac("sha256", CAPTURE_SECRET, body, "hex");
  const res = http.post(`${BASE_URL}/api/webhooks/capture/${INTEGRATION_ID}`, body, {
    headers: {
      "Content-Type": "application/json",
      "x-capture-signature": `sha256=${sig}`,
    },
    tags: { type: "webhook", role: "attacker" },
  });

  if (res.status >= 200 && res.status < 300) attackerAccepted.add(1);
  else attackerRejected.add(1);
}

export function victimOperations() {
  // Victim does normal MCP operations: query alerts, get status
  const ops = [
    { tool: "query_alerts", args: { limit: 5 } },
    { tool: "get_status", args: {} },
  ];

  for (const op of ops) {
    const start = Date.now();
    const body = mcpPayload(op.tool, op.args);
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp", role: "victim" },
    });

    const elapsed = Date.now() - start;
    victimLatency.add(elapsed);

    if (res.status !== 200) {
      victimErrors.add(1);
    }

    check(res, {
      "victim MCP responds": (r) => r.status === 200 || r.status === 429,
    });

    sleep(1 + Math.random());
  }
}
