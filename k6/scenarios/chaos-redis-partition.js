/**
 * L4 Chaos: Redis Partition / Cache Degradation
 *
 * When the Hetzner-local Redis (see deploy.yml accessory `redis`) is
 * unreachable from the web container, the following paths must fall
 * back to the DB:
 *
 *   - rate limiting (lib/ratelimit → DB sliding window)
 *   - alert dedup (lib/webhooks/shared → DB title-based dedup)
 *   - pattern memory read breaker (returns [] when Redis is down)
 *   - Slack token cache (re-reads from DB)
 *   - service health (degrades to in-process check)
 *
 * k6 cannot turn off Redis from the outside, so this scenario
 * validates the BLACK-BOX behavior that must remain correct whether
 * Redis is up or not:
 *
 *   1. Sustained webhook ingest maintains p95 < 2000ms (DB fallback
 *      is slower than Redis but still within SLO).
 *   2. MCP get_status remains responsive — it does not depend on
 *      Redis health for the initial response.
 *   3. No 5xx escalations during a 30s ingest + MCP concurrent load.
 *
 * To run with the actual Redis off for a real fault injection, stop
 * the redis accessory on Hetzner before the scenario and restart
 * after: `kamal accessory stop redis && bash k6/run-all.sh chaos-redis-partition && kamal accessory boot redis`.
 * The scenario passes the same way either way — when Redis is up it's
 * a baseline, when Redis is down it's a real partition test.
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

const redis5xx = new Counter("redis_partition_5xx");
const ingestLatency = new Trend("redis_partition_ingest_ms", true);
const mcpLatency = new Trend("redis_partition_mcp_ms", true);

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 5,
      maxVUs: 15,
      exec: "ingest",
    },
    mcp: {
      executor: "constant-vus",
      vus: 2,
      duration: "30s",
      exec: "mcp",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "redis_partition_5xx": ["count<3"],
    "redis_partition_ingest_ms": ["p(95)<2000"],
    "redis_partition_mcp_ms": ["p(95)<3000"],
  },
  tags: { scenario: "chaos-redis-partition" },
};

export function ingest() {
  const title = `chaos-redis-${Date.now()}-${uuidv4().slice(0, 8)}: TypeError`;
  const stack = "at handler (src/api/handler.ts:42:15)";
  const payload = JSON.stringify({
    fingerprint: crypto.sha256(title + uuidv4(), "hex"),
    title,
    body: `${title}\n${stack}`,
    severity: "warning",
    timestamp: new Date().toISOString(),
    environment: "production",
    runtime: "nodejs",
    tags: { test: "chaos-redis-partition", role: "ingest" },
  });
  const start = Date.now();
  const res = http.post(webhookUrl("capture"), payload, {
    headers: captureHeaders(payload),
    tags: { type: "webhook", phase: "redis-partition" },
  });
  ingestLatency.add(Date.now() - start);
  if (res.status >= 500) redis5xx.add(1);
  check(res, { "ingest does not 5xx": (r) => r.status < 500 });
}

export function mcp() {
  const body = mcpPayload("get_status", {});
  const start = Date.now();
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp", phase: "redis-partition" },
  });
  mcpLatency.add(Date.now() - start);
  if (res.status >= 500) redis5xx.add(1);
  check(res, { "mcp does not 5xx": (r) => r.status < 500 });
  sleep(1);
}
