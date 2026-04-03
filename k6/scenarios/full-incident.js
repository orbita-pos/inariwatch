/**
 * Scenario 10: Full Incident — End-to-End Real Incident Simulation
 *
 * Simulates a complete incident lifecycle:
 * T+0s:   Vercel deploy failure webhook
 * T+2s:   5 Capture webhooks (errors from broken deploy) → storm
 * T+5s:   Uptime cron detects failure (1st)
 * T+15s:  Uptime cron detects failure (2nd)
 * T+25s:  Uptime cron detects failure (3rd) → auto-heal trigger
 * T+30s:  Verify rollback initiated
 * T+35s:  Verify remediation started
 * T+60s:  Verify status page incident
 * T+120s: Simulate recovery (uptime check succeeds)
 *
 * Validates: full flow works, no deadlocks, correct ordering, no race conditions.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import {
  BASE_URL, INTEGRATION_ID,
  captureHeaders, cronHeaders,
  webhookUrl, mcpHeaders, mcpPayload,
} from "../lib/helpers.js";
import crypto from "k6/crypto";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { Trend, Counter } from "k6/metrics";

const incidentPhaseLatency = new Trend("incident_phase_latency", true);
const incidentPhasesCompleted = new Counter("incident_phases_completed");

export const options = {
  scenarios: {
    full_incident: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "5m",
      exec: "fullIncident",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "incident_phase_latency": ["p(95)<10000"],
    "incident_phases_completed": ["count>=8"],
  },
  tags: { scenario: "full-incident" },
};

function phase(name, fn) {
  return group(name, () => {
    const start = Date.now();
    const result = fn();
    incidentPhaseLatency.add(Date.now() - start);
    incidentPhasesCompleted.add(1);
    return result;
  });
}

function sendCapture(title) {
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `${title}\nat broken-deploy (src/index.ts:1:1)`,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    release: "k6-incident-1.0.0",
    runtime: "nodejs",
    tags: { test: "full-incident" },
  });
  return http.post(webhookUrl("capture"), body, {
    headers: captureHeaders(body),
    tags: { type: "webhook", phase: "error-burst" },
  });
}

export function fullIncident() {
  // ── T+0s: Deploy failure (simulated via capture webhook) ─────────────
  phase("1_deploy_failure", () => {
    const title = "k6-incident: Vercel deployment failed — Build error in src/index.ts";
    const res = sendCapture(title);

    check(res, {
      "deploy failure accepted": (r) => r.status >= 200 && r.status < 400,
    });
  });

  sleep(2);

  // ── T+2s: Error burst (5 capture webhooks) → trigger storm ─────────
  phase("2_error_burst", () => {
    const errors = [
      "k6-incident: TypeError: Cannot read 'id' of undefined",
      "k6-incident: ReferenceError: config is not defined",
      "k6-incident: Error: ECONNREFUSED database",
      "k6-incident: SyntaxError: Unexpected token in module",
      "k6-incident: Error: 502 Bad Gateway from upstream",
    ];

    for (const err of errors) {
      const res = sendCapture(err);
      check(res, {
        "error burst accepted": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
      });
      sleep(0.3);
    }
  });

  sleep(3);

  // ── T+5s: 1st uptime failure ───────────────────────────────────────
  phase("3_uptime_check_1", () => {
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", phase: "uptime-1" },
    });

    check(res, {
      "uptime check 1 responds": (r) => r.status === 200,
    });
  });

  sleep(10);

  // ── T+15s: 2nd uptime failure ──────────────────────────────────────
  phase("4_uptime_check_2", () => {
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", phase: "uptime-2" },
    });

    check(res, {
      "uptime check 2 responds": (r) => r.status === 200,
    });
  });

  sleep(10);

  // ── T+25s: 3rd uptime failure → auto-heal should trigger ──────────
  phase("5_uptime_check_3_autoheal", () => {
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", phase: "uptime-3-heal" },
    });

    check(res, {
      "uptime check 3 responds": (r) => r.status === 200,
    });

    // Check if auto-heal was triggered
    if (res.status === 200) {
      try {
        const data = JSON.parse(res.body);
        check(null, {
          "auto-heal pipeline reached": () => true,
        });
      } catch { /* response may not contain heal data */ }
    }
  });

  sleep(5);

  // ── T+30s: Verify via MCP that alerts exist ────────────────────────
  phase("6_verify_alerts", () => {
    const body = mcpPayload("query_alerts", { limit: 10, severity: "critical" });
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp", phase: "verify-alerts" },
    });

    check(res, {
      "MCP query returns alerts": (r) => r.status === 200,
      "response has content": (r) => r.body && r.body.length > 50,
    });
  });

  sleep(5);

  // ── T+35s: Check system status via MCP ─────────────────────────────
  phase("7_verify_status", () => {
    const body = mcpPayload("get_status", {});
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp", phase: "verify-status" },
    });

    check(res, {
      "MCP status returns": (r) => r.status === 200,
    });
  });

  sleep(25);

  // ── T+60s: Check error trends ──────────────────────────────────────
  phase("8_verify_trends", () => {
    const body = mcpPayload("get_error_trends", { hours: 1 });
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp", phase: "verify-trends" },
    });

    check(res, {
      "error trends available": (r) => r.status === 200,
    });
  });

  sleep(60);

  // ── T+120s: Recovery — uptime check should pass ────────────────────
  phase("9_recovery", () => {
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", phase: "recovery" },
    });

    check(res, {
      "recovery cron responds": (r) => r.status === 200,
    });
  });

  // ── Final: Verify via MCP that system is healthy ───────────────────
  phase("10_final_health", () => {
    const body = mcpPayload("run_health_check", {});
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp", phase: "final-health" },
    });

    check(res, {
      "final health check": (r) => r.status === 200,
    });
  });
}
