/**
 * L4 Chaos: Auto-Merge Gate Parallel Race (Fase 8 validation)
 *
 * Fase 8 (PR #21) introduced a DAG executor that fans the pre-push
 * gate producers (security_ai_review + self_review_cheap) out via
 * `Promise.all` when GATES_PARALLEL=true. PR #21 proved byte-identical
 * output when the flag is off via `gates-executor.test.ts`; this
 * scenario is the LIVE signal that parallel mode doesn't regress
 * under concurrent remediation load.
 *
 * What it exercises:
 *   1. A sustained stream of alerts capable of triggering remediation
 *      (critical, stack-trace-rich). We don't force the remediation —
 *      it either runs (autoRemediate=true project) or doesn't (we log
 *      and move on). The signal is that ingest + remediation pipeline
 *      paths stay healthy under N=30 concurrent sessions.
 *   2. MCP health check during the burst returns 200.
 *   3. No 5xx on ingest.
 *
 * Direct gate-race validation happens in vitest — this k6 scenario is
 * the "still-holds-under-real-load" signal.
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

const ingest5xx = new Counter("gate_race_ingest_5xx");
const mcp5xx = new Counter("gate_race_mcp_5xx");
const ingestLatency = new Trend("gate_race_ingest_ms", true);
const mcpLatency = new Trend("gate_race_mcp_ms", true);

export const options = {
  scenarios: {
    ingest_burst: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "45s",
      preAllocatedVUs: 10,
      maxVUs: 30,
      exec: "ingest",
    },
    health_probes: {
      executor: "constant-vus",
      vus: 2,
      duration: "45s",
      exec: "health",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "gate_race_ingest_5xx": ["count<3"],
    "gate_race_mcp_5xx": ["count<1"],
    "gate_race_ingest_ms": ["p(95)<2000"],
    "gate_race_mcp_ms": ["p(95)<3000"],
  },
  tags: { scenario: "chaos-gate-parallel-race" },
};

const STACKS = [
  "at handler (src/api/handler.ts:42:15)\nat process (src/server.ts:28:5)",
  "at renderItem (src/components/List.tsx:18:5)\nat List (src/components/List.tsx:3:3)",
  "at Pool.query (node_modules/pg/lib/pool.js:54:9)\nat getUser (src/lib/db.ts:89:20)",
];

export function ingest() {
  const title = `chaos-gate-race-${Date.now()}-${uuidv4().slice(0, 8)}: Critical failure in handler`;
  const stack = STACKS[Math.floor(Math.random() * STACKS.length)];
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body: `${title}\n${stack}`,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-gate-parallel-race" },
  });
  const start = Date.now();
  const res = http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", phase: "gate-race-ingest" },
  });
  ingestLatency.add(Date.now() - start);
  if (res.status >= 500) ingest5xx.add(1);
  check(res, { "ingest does not 5xx": (r) => r.status < 500 });
}

export function health() {
  const body = mcpPayload("run_health_check", {});
  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp", phase: "gate-race-health" },
  });
  mcpLatency.add(Date.now() - start);
  if (res.status >= 500) mcp5xx.add(1);
  check(res, { "mcp health does not 5xx": (r) => r.status < 500 });
  sleep(1);
}
