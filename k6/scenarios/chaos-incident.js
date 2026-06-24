/**
 * L4 Chaos: Full Incident Lifecycle Under Fault Injection
 *
 * Unlike full-incident.js (happy path), this scenario injects faults:
 * - Phase 1: Webhook burst with mixed valid/malformed payloads
 * - Phase 2: Concurrent cron triggers (overlap test)
 * - Phase 3: Storm + continued alerts (notification suppression)
 * - Phase 4: MCP verification under concurrent webhook load
 * - Phase 5: Recovery verification
 *
 * This tests system resilience, not just correctness.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import crypto from "k6/crypto";
import {
  BASE_URL, INTEGRATION_ID,
  captureHeaders, cronHeaders, mcpHeaders, mcpPayload,
  webhookUrl,
} from "../lib/helpers.js";
import { CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { chaosPhasesPassed, chaosPhasesTotal, chaosLatency } from "../lib/metrics.js";

export const options = {
  scenarios: {
    chaos_incident: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "4m",
      exec: "chaosIncident",
    },
  },
  thresholds: {
    ...CHAOS_THRESHOLDS,
    "chaos_phases_passed": ["count>=4"],
  },
  tags: { scenario: "chaos-incident" },
};

function phase(name, fn) {
  return group(name, () => {
    const start = Date.now();
    chaosPhasesTotal.add(1);
    let passed = false;
    try {
      passed = fn();
    } catch (e) {
      console.error(`Phase ${name} threw: ${e}`);
    }
    chaosLatency.add(Date.now() - start);
    if (passed) chaosPhasesPassed.add(1);
    return passed;
  });
}

function sendCapture(title, severity) {
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `${title}\nat chaos-test (src/index.ts:1:1)`,
    severity: severity || "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-incident" },
  });
  return http.post(webhookUrl("capture"), body, {
    headers: captureHeaders(body),
    tags: { type: "webhook", phase: "chaos" },
  });
}

export function chaosIncident() {
  // ── Phase 1: Mixed valid + malformed webhook burst ─────────────────
  phase("1_mixed_webhook_burst", () => {
    let accepted = 0;
    let rejected = 0;

    // 5 valid alerts
    for (let i = 0; i < 5; i++) {
      const res = sendCapture(`chaos-${Date.now()}-${i}: TypeError in handler`);
      if (res.status >= 200 && res.status < 300) accepted++;
      sleep(0.1);
    }

    // 3 malformed payloads (bad JSON, no signature, oversized)
    const malformed = [
      // Bad JSON
      http.post(webhookUrl("capture"), "not json{{{", {
        headers: { "Content-Type": "application/json", "x-capture-signature": "sha256=invalid" },
        tags: { type: "webhook", phase: "malformed" },
      }),
      // Wrong signature
      http.post(webhookUrl("capture"), JSON.stringify({ title: "test" }), {
        headers: { "Content-Type": "application/json", "x-capture-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" },
        tags: { type: "webhook", phase: "malformed" },
      }),
      // Missing signature
      http.post(webhookUrl("capture"), JSON.stringify({ title: "no-sig" }), {
        headers: { "Content-Type": "application/json" },
        tags: { type: "webhook", phase: "malformed" },
      }),
    ];

    for (const res of malformed) {
      if (res.status >= 400) rejected++;
    }

    return check(null, {
      "valid webhooks accepted": () => accepted >= 3,
      "malformed webhooks rejected": () => rejected >= 2,
    });
  });

  sleep(2);

  // ── Phase 2: Concurrent cron triggers (overlap test) ───────────────
  phase("2_concurrent_cron", () => {
    // Fire 3 cron triggers simultaneously
    const responses = http.batch([
      ["GET", `${BASE_URL}/api/cron/poll`, null, { headers: cronHeaders(), tags: { type: "cron" } }],
      ["GET", `${BASE_URL}/api/cron/poll`, null, { headers: cronHeaders(), tags: { type: "cron" } }],
      ["GET", `${BASE_URL}/api/cron/poll`, null, { headers: cronHeaders(), tags: { type: "cron" } }],
    ]);

    let executed = 0;
    let skipped = 0;
    for (const res of responses) {
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body);
          if (data.skipped) skipped++;
          else executed++;
        } catch {
          executed++;
        }
      }
    }

    return check(null, {
      "at least one cron executed": () => executed >= 1,
      "concurrent crons handled": () => (executed + skipped) === 3,
    });
  });

  sleep(3);

  // ── Phase 3: Storm trigger + continued alerts ─────────────────────
  phase("3_storm_plus_continued", () => {
    // Send 8 alerts rapidly — first 5 trigger storm, next 3 join it
    const sameError = "chaos-storm: Connection pool exhausted";
    let responses = [];

    for (let i = 0; i < 8; i++) {
      // Use unique titles so dedup doesn't block them
      const title = `${sameError} [variant-${i}-${Date.now()}]`;
      responses.push(sendCapture(title));
      sleep(0.2);
    }

    const accepted = responses.filter((r) => r.status >= 200 && r.status < 300).length;
    const rateLimited = responses.filter((r) => r.status === 429).length;

    return check(null, {
      "most storm alerts accepted": () => accepted >= 5,
      "system handles rapid fire": () => (accepted + rateLimited) === 8,
    });
  });

  sleep(5);

  // ── Phase 4: MCP under concurrent load ────────────────────────────
  phase("4_mcp_under_load", () => {
    // Query alerts while system is processing storm
    const queries = http.batch([
      ["POST", `${BASE_URL}/api/mcp`, mcpPayload("query_alerts", { limit: 5 }), { headers: mcpHeaders(), tags: { type: "mcp" } }],
      ["POST", `${BASE_URL}/api/mcp`, mcpPayload("get_status", {}), { headers: mcpHeaders(), tags: { type: "mcp" } }],
      ["POST", `${BASE_URL}/api/mcp`, mcpPayload("get_error_trends", { hours: 1 }), { headers: mcpHeaders(), tags: { type: "mcp" } }],
    ]);

    const allOk = queries.every((r) => r.status === 200);

    return check(null, {
      "MCP responds during storm": () => allOk,
    });
  });

  sleep(2);

  // ── Phase 5: System health after chaos ────────────────────────────
  phase("5_post_chaos_health", () => {
    const res = http.post(`${BASE_URL}/api/mcp`, mcpPayload("run_health_check", {}), {
      headers: mcpHeaders(),
      tags: { type: "mcp", phase: "health" },
    });

    return check(res, {
      "health check passes after chaos": (r) => r.status === 200,
    });
  });
}
