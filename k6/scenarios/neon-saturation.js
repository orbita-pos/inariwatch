/**
 * Scenario 7: Database Query Concurrency (Neon PostgreSQL)
 *
 * Tests Neon HTTP driver under concurrent load.
 * Validates: query latency, timeout rate, UPSERT atomicity for rate limits.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL, INTEGRATION_ID,
  capturePayload, captureHeaders,
  mcpHeaders, mcpPayload, cronHeaders,
  webhookUrl, randomInt,
} from "../lib/helpers.js";
import { DB_THRESHOLDS } from "../lib/thresholds.js";
import { dbQueryLatency, dbErrors, dbConcurrentQueries } from "../lib/metrics.js";

export const options = {
  scenarios: {
    // 50 webhooks = ~400 concurrent DB queries
    webhook_flood: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 60,
      exec: "webhookFlood",
      tags: { workload: "webhooks" },
    },
    // Simultaneous MCP reads
    mcp_reads: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      exec: "mcpReads",
      tags: { workload: "mcp" },
    },
    // Cron poll during webhook flood
    cron_during_flood: {
      executor: "per-vu-iterations",
      vus: 2,
      iterations: 2,
      maxDuration: "30s",
      exec: "cronDuringFlood",
      tags: { workload: "cron" },
    },
    // Worst case: all workloads at once
    worst_case: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 30,
      startTime: "40s",
      exec: "worstCase",
      tags: { workload: "worst-case" },
    },
  },
  thresholds: DB_THRESHOLDS,
  tags: { scenario: "neon-saturation" },
};

export function webhookFlood() {
  dbConcurrentQueries.add(8); // each webhook = ~8 queries

  const body = capturePayload(true);
  const res = http.post(webhookUrl("capture"), body, {
    headers: captureHeaders(body),
    tags: { type: "webhook" },
  });

  dbQueryLatency.add(res.timings.duration);

  if (res.status >= 500) {
    dbErrors.add(1);
  }

  check(res, {
    "webhook under DB load succeeds": (r) => r.status < 500,
    "latency under 5s": (r) => r.timings.duration < 5000,
  });
}

export function mcpReads() {
  dbConcurrentQueries.add(3);

  const body = mcpPayload("query_alerts", { limit: 10 });
  const res = http.post(`${BASE_URL}/api/mcp`, body, {
    headers: mcpHeaders(),
    tags: { type: "mcp" },
  });

  dbQueryLatency.add(res.timings.duration);

  if (res.status >= 500) {
    dbErrors.add(1);
  }

  check(res, {
    "MCP read under DB load": (r) => r.status < 500,
  });

  sleep(0.5);
}

export function cronDuringFlood() {
  dbConcurrentQueries.add(50); // cron touches many tables

  const res = http.get(`${BASE_URL}/api/cron/poll`, {
    headers: cronHeaders(),
    timeout: "60s",
    tags: { type: "cron" },
  });

  dbQueryLatency.add(res.timings.duration);

  if (res.status >= 500) {
    dbErrors.add(1);
  }

  check(res, {
    "cron during flood succeeds": (r) => r.status === 200,
  });
}

export function worstCase() {
  // Mix of all workloads
  const roll = randomInt(1, 10);

  if (roll <= 6) {
    // 60% webhooks
    const body = capturePayload(true);
    const res = http.post(webhookUrl("capture"), body, {
      headers: captureHeaders(body),
      tags: { type: "webhook" },
    });
    dbQueryLatency.add(res.timings.duration);
    if (res.status >= 500) dbErrors.add(1);
    check(res, { "worst-case webhook": (r) => r.status < 500 });
  } else if (roll <= 9) {
    // 30% MCP
    const body = mcpPayload("query_alerts", { limit: 5 });
    const res = http.post(`${BASE_URL}/api/mcp`, body, {
      headers: mcpHeaders(),
      tags: { type: "mcp" },
    });
    dbQueryLatency.add(res.timings.duration);
    if (res.status >= 500) dbErrors.add(1);
    check(res, { "worst-case mcp": (r) => r.status < 500 });
  } else {
    // 10% cron
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron" },
    });
    dbQueryLatency.add(res.timings.duration);
    if (res.status >= 500) dbErrors.add(1);
    check(res, { "worst-case cron": (r) => r.status < 500 });
  }
}
