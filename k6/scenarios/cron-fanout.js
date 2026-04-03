/**
 * Scenario 6: Cron Orchestrator Under Load
 *
 * Tests the cron fan-out to 7 sub-routes in parallel.
 * Validates: no race conditions, sub-poller timing, overlap handling.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { BASE_URL, cronHeaders } from "../lib/helpers.js";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { Trend, Counter } from "k6/metrics";

const cronLatency = new Trend("cron_total_latency", true);
const subPollerLatency = new Trend("sub_poller_latency", true);
const cronOverlaps = new Counter("cron_overlaps");

export const options = {
  scenarios: {
    // Simulate 5 overlapping cron invocations (cron-job.org can overlap)
    cron_overlap: {
      executor: "shared-iterations",
      vus: 5,
      iterations: 5,
      maxDuration: "3m",
      exec: "cronOverlap",
    },
    // Test each sub-poller individually
    sub_pollers: {
      executor: "per-vu-iterations",
      vus: 7,
      iterations: 1,
      startTime: "3m30s",
      exec: "subPollers",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "cron_total_latency": ["p(95)<30000"],  // cron can take up to 30s
    "sub_poller_latency": ["p(95)<15000"],  // sub-pollers up to 15s
  },
  tags: { scenario: "cron-fanout" },
};

const SUB_ROUTES = ["github", "vercel", "sentry", "uptime", "postgres", "npm", "expo"];

export function cronOverlap() {
  cronOverlaps.add(1);

  group("main_cron", () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/cron/poll`, {
      headers: cronHeaders(),
      timeout: "60s",
      tags: { type: "cron", route: "main" },
    });

    cronLatency.add(Date.now() - start);

    check(res, {
      "cron returns 200": (r) => r.status === 200,
      "cron returns JSON": (r) => {
        try { JSON.parse(r.body); return true; } catch { return false; }
      },
    });
  });
}

export function subPollers() {
  // Each VU tests a different sub-poller
  const route = SUB_ROUTES[__VU % SUB_ROUTES.length];

  group(`poller_${route}`, () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/cron/poll/${route}`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", route },
    });

    subPollerLatency.add(Date.now() - start);

    check(res, {
      [`${route} returns 200`]: (r) => r.status === 200,
      [`${route} returns JSON`]: (r) => {
        try { JSON.parse(r.body); return true; } catch { return false; }
      },
      [`${route} under 15s`]: () => (Date.now() - start) < 15000,
    });
  });
}
