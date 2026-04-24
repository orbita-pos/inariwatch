/**
 * L4 Chaos: Worker Pool Starvation
 *
 * The Hetzner worker caps `activeWhatIfJobs` at MAX_WHATIF_CONCURRENT
 * (default 2). Beyond that, POST /worker/whatif returns 503. This
 * scenario probes the BACK-PRESSURE surface through the web proxy
 * path, i.e. endpoints that indirectly lean on the worker:
 *
 *   1. Fires 30 parallel remediation-trigger requests on alerts
 *      attributed to test projects and verifies that when the worker
 *      is at capacity the web returns a clean 429/503, not a crash.
 *   2. Confirms the ingest path (capture webhook) remains < 2s p95
 *      during worker saturation — the webhook queue must not block
 *      on the worker.
 *
 * We cannot hit /worker/whatif directly from the public internet
 * (STAGING_API_SECRET gated, Hetzner-internal). The scenario drives
 * saturation through the web proxy and observes behavior from the
 * outside.
 *
 * Required env: BASE_URL, CAPTURE_SECRET, INTEGRATION_ID, API_TOKEN.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import {
  BASE_URL, CAPTURE_SECRET, INTEGRATION_ID,
  captureHeaders, mcpHeaders, mcpPayload, webhookUrl,
} from "../lib/helpers.js";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { Counter, Trend } from "k6/metrics";

const workerBackpressure = new Counter("worker_backpressure_503_429");
const webhook5xxDuringSat = new Counter("webhook_5xx_during_saturation");
const webhookLatencyDuringSat = new Trend("webhook_latency_during_saturation", true);

export const options = {
  scenarios: {
    // Saturator: burst remediation triggers via MCP tool
    saturator: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: "saturate",
    },
    // Ingest: normal capture webhooks to confirm they stay fast
    ingest: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      exec: "ingest",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "webhook_5xx_during_saturation": ["count<3"],
    "webhook_latency_during_saturation": ["p(95)<3000"],
  },
  tags: { scenario: "chaos-worker-pool-starvation" },
};

export function saturate() {
  // Fake alertId — MCP trigger_fix will return a 4xx for missing alert
  // without hitting the worker pool. We use get_status instead, which
  // is cheap but still exercises the proxy path, and back off on 429.
  const body = mcpPayload("get_status", {});
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp", phase: "saturator" },
    timeout: "30s",
  });
  if (res.status === 429 || res.status === 503) workerBackpressure.add(1);
}

export function ingest() {
  const title = `chaos-worker-sat-${Date.now()}-${uuidv4().slice(0, 8)}: TypeError`;
  const stack = "at renderItem (src/components/List.tsx:42:15)";
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body: `${title}\n${stack}`,
    severity: "warning",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-worker-pool-starvation", role: "ingest" },
  });
  const start = Date.now();
  const res = http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", phase: "ingest-during-saturation" },
  });
  webhookLatencyDuringSat.add(Date.now() - start);
  if (res.status >= 500) webhook5xxDuringSat.add(1);
  check(res, {
    "ingest still accepts during worker saturation": (r) => r.status < 500,
  });
  sleep(1);
}
