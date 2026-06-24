/**
 * L4 Chaos: SSE Connection Stress
 *
 * Opens 50+ SSE connections to /api/alerts/stream, then:
 * - Abruptly disconnects half (simulating browser crash / network drop)
 * - Keeps other half alive for 30s
 * - Sends webhooks during SSE connections (should trigger events)
 * - Verifies server stays responsive after mass disconnect
 *
 * Note: k6 doesn't natively support SSE. We use HTTP long-polling
 * to simulate the connection lifecycle and measure server behavior.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { BASE_URL, API_TOKEN, captureHeaders, webhookUrl, CAPTURE_SECRET } from "../lib/helpers.js";
import { SSE_CHAOS_THRESHOLDS } from "../lib/thresholds.js";
import { sseConnectionTime, sseEventsReceived, sseLeakedConnections } from "../lib/metrics.js";
import crypto from "k6/crypto";
import { Counter, Trend } from "k6/metrics";

const sseConnections = new Counter("sse_connections_opened");
const sseAbruptDisconnects = new Counter("sse_abrupt_disconnects");
const postDisconnectLatency = new Trend("post_disconnect_latency", true);

export const options = {
  scenarios: {
    // Phase 1: Open many SSE connections
    sse_flood: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 50 },  // ramp to 50 connections
        { duration: "20s", target: 50 },  // hold
        { duration: "5s", target: 0 },    // abrupt disconnect (VUs stop)
      ],
      exec: "sseConnection",
    },
    // Phase 2: Send alerts during SSE connections
    alert_sender: {
      executor: "constant-vus",
      vus: 2,
      duration: "25s",
      startTime: "5s",
      exec: "sendAlertsDuringSSE",
    },
    // Phase 3: Verify server health after mass disconnect
    health_check: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      startTime: "40s",
      exec: "postDisconnectHealth",
    },
  },
  thresholds: {
    ...SSE_CHAOS_THRESHOLDS,
    "post_disconnect_latency": ["p(95)<3000"],
    checks: ["rate>0.80"],
  },
  tags: { scenario: "chaos-sse" },
};

export function sseConnection() {
  sseConnections.add(1);

  // Simulate SSE connection via long-polling GET
  // The real SSE endpoint at /api/alerts/stream requires auth session
  // We test the HTTP-level behavior (connection, timeout, cleanup)
  const start = Date.now();

  const res = http.get(`${BASE_URL}/api/alerts/stream`, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Cookie: `next-auth.session-token=${API_TOKEN}`,
    },
    timeout: "15s",
    tags: { type: "sse" },
  });

  sseConnectionTime.add(Date.now() - start);

  // SSE returns 200 with event-stream content type (or 401 if no session)
  check(res, {
    "SSE connection established or auth required": (r) =>
      r.status === 200 || r.status === 401,
  });

  // If connected, count events in response
  if (res.status === 200 && res.body) {
    const events = (res.body.match(/^event:/gm) || []).length;
    sseEventsReceived.add(events);
  }

  // Random: some VUs disconnect abruptly (just stop), others hold
  if (Math.random() > 0.5) {
    sseAbruptDisconnects.add(1);
    // Abrupt: just return (k6 closes the connection)
    return;
  }

  // Hold connection for a bit
  sleep(5 + Math.random() * 10);
}

export function sendAlertsDuringSSE() {
  // Send capture webhooks while SSE connections are active
  // This should trigger SSE events for connected clients
  const title = `chaos-sse-alert-${Date.now()}`;
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `SSE test alert: ${title}`,
    severity: "info",
    timestamp: new Date().toISOString(),
    runtime: "nodejs",
    tags: { test: "chaos-sse" },
  });

  const sig = crypto.hmac("sha256", CAPTURE_SECRET, body, "hex");
  const res = http.post(webhookUrl("capture"), body, {
    headers: {
      "Content-Type": "application/json",
      "x-capture-signature": `sha256=${sig}`,
    },
    tags: { type: "webhook", phase: "sse-trigger" },
  });

  check(res, {
    "alert accepted during SSE load": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
  });

  sleep(2 + Math.random() * 3);
}

export function postDisconnectHealth() {
  sleep(2);

  // After mass disconnect, server should still respond quickly
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/alerts/stream`, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Cookie: `next-auth.session-token=${API_TOKEN}`,
    },
    timeout: "5s",
    tags: { type: "sse", phase: "post-disconnect" },
  });

  const elapsed = Date.now() - start;
  postDisconnectLatency.add(elapsed);

  check(res, {
    "server responsive after mass disconnect": (r) =>
      r.status === 200 || r.status === 401,
    "response time under 3s": () => elapsed < 3000,
  });
}
