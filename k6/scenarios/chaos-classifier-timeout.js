/**
 * L4 Chaos: Tier-Router Classifier Timeout
 *
 * The Fase 6 classifier (lib/ai/tier-router.ts) calls gpt-5-nano on
 * every remediation and has an in-process circuit breaker: 3 errors
 * in 60s → skip the LLM and use heuristic rules for the next 60s.
 *
 * From the outside we cannot make OpenAI slow, but we can flood the
 * ingest pipeline with alerts at a rate that would saturate the
 * nano-model calls (if they were slow) and verify:
 *
 *   1. Ingest stays healthy (classifier errors do not propagate back
 *      to webhook accept).
 *   2. The circuit breaker, if it trips, does not 5xx the ingest —
 *      remediation either routes via heuristic or legacy Tier 2.
 *   3. MCP remains responsive during the burst.
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

const classifier5xx = new Counter("classifier_timeout_5xx");
const classifierIngestLatency = new Trend("classifier_timeout_ingest_ms", true);

export const options = {
  scenarios: {
    classifier_burst: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 10,
      maxVUs: 40,
      stages: [
        { target: 15, duration: "15s" }, // warm up
        { target: 30, duration: "20s" }, // saturation point
        { target: 10, duration: "10s" }, // cool down
      ],
      exec: "burst",
    },
    mcp_probe: {
      executor: "constant-vus",
      vus: 1,
      duration: "45s",
      exec: "probe",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "classifier_timeout_5xx": ["count<5"],
    "classifier_timeout_ingest_ms": ["p(95)<2500"],
  },
  tags: { scenario: "chaos-classifier-timeout" },
};

// Use a range of fingerprints so alerts aren't deduped instantly.
export function burst() {
  const title = `chaos-classifier-${Date.now()}-${uuidv4().slice(0, 8)}: TypeError`;
  const stack = "at handler (src/api/handler.ts:42:15)";
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body: `${title}\n${stack}`,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-classifier-timeout" },
  });
  const start = Date.now();
  const res = http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", phase: "classifier-burst" },
  });
  classifierIngestLatency.add(Date.now() - start);
  if (res.status >= 500) classifier5xx.add(1);
  check(res, { "ingest does not 5xx during classifier burst": (r) => r.status < 500 });
}

export function probe() {
  const body = mcpPayload("get_status", {});
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp", phase: "classifier-probe" },
  });
  if (res.status >= 500) classifier5xx.add(1);
  check(res, { "mcp probe does not 5xx": (r) => r.status < 500 });
  sleep(2);
}
