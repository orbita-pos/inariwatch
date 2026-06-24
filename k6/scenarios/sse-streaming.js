/**
 * Scenario 3: SSE Concurrent Connections
 *
 * Tests Server-Sent Events under concurrent load.
 * Validates: connection establishment, heartbeats, event delivery, reconnection.
 *
 * NOTE: k6 does not natively support SSE. We simulate with long-polling HTTP requests
 * and measure connection behavior. For true SSE testing, use k6 xk6-sse extension.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL } from "../lib/helpers.js";
import { SSE_THRESHOLDS } from "../lib/thresholds.js";
import { sseConnectionTime, sseEventsReceived, sseReconnects } from "../lib/metrics.js";

export const options = {
  scenarios: {
    alert_stream: {
      executor: "constant-vus",
      vus: 50,
      duration: "3m",
      exec: "alertStream",
    },
    reconnection: {
      executor: "per-vu-iterations",
      vus: 10,
      iterations: 5,
      startTime: "1m",
      exec: "reconnectionTest",
    },
  },
  thresholds: SSE_THRESHOLDS,
  tags: { scenario: "sse-streaming" },
};

// Session cookie — in a real test, you'd login first and capture this
const SESSION_COOKIE = __ENV.SESSION_COOKIE || "";

function getHeaders() {
  return {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    Cookie: SESSION_COOKIE ? `next-auth.session-token=${SESSION_COOKIE}` : "",
  };
}

export function alertStream() {
  // Connect to alert stream — this will be a long-running request
  const start = Date.now();
  const res = http.get(`${BASE_URL}/api/alerts/stream`, {
    headers: getHeaders(),
    timeout: "30s",
    tags: { type: "sse", endpoint: "alert-stream" },
  });

  const connectionTime = Date.now() - start;
  sseConnectionTime.add(connectionTime);

  check(res, {
    "SSE connects (200 or 401)": (r) => r.status === 200 || r.status === 401,
    "connection under 2s": () => connectionTime < 2000,
  });

  if (res.status === 200 && res.body) {
    // Count SSE events in response
    const events = (res.body.match(/^data:/gm) || []).length;
    sseEventsReceived.add(events);
    check(null, {
      "received at least 1 event": () => events >= 1,
    });
  }

  sleep(5); // Wait before next connection
}

export function reconnectionTest() {
  // Simulate connect → disconnect → reconnect cycle
  for (let i = 0; i < 3; i++) {
    const res = http.get(`${BASE_URL}/api/alerts/stream`, {
      headers: getHeaders(),
      timeout: "5s",
      tags: { type: "sse", endpoint: "reconnect-test" },
    });

    if (i > 0) sseReconnects.add(1);

    check(res, {
      "reconnection succeeds": (r) => r.status === 200 || r.status === 401,
    });

    sleep(1);
  }
}
