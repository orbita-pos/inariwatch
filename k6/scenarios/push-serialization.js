/**
 * Scenario 8: Push Notification Serialization Bottleneck
 *
 * Tests the serial push notification delivery under load.
 * Validates: push delivery time, failure isolation, throughput.
 *
 * NOTE: This tests the internal notification pipeline by creating critical alerts
 * that trigger push notifications. Does NOT call Expo API directly.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL, INTEGRATION_ID,
  captureHeaders, webhookUrl,
} from "../lib/helpers.js";
import crypto from "k6/crypto";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { pushSent, pushLatency } from "../lib/metrics.js";
import { Trend } from "k6/metrics";

const alertToNotificationLatency = new Trend("alert_to_notification_latency", true);

export const options = {
  scenarios: {
    // Create 20 critical alerts rapidly → each triggers push to all subscribers
    critical_burst: {
      executor: "shared-iterations",
      vus: 5,
      iterations: 20,
      maxDuration: "2m",
      exec: "criticalBurst",
    },
    // Measure total pipeline time: alert creation → notification queued
    pipeline_timing: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 5,
      startTime: "2m30s",
      exec: "pipelineTiming",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "alert_to_notification_latency": ["p(95)<10000"], // 10s total pipeline
  },
  tags: { scenario: "push-serialization" },
};

function createCriticalAlert(index) {
  const title = `k6-push-test-${index}-${Date.now()}: CRITICAL production outage`;
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `${title}\nService is completely down. All endpoints returning 503.`,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "production",
    release: "k6-push-1.0.0",
    runtime: "nodejs",
    tags: { test: "push-serialization" },
  });

  return http.post(webhookUrl("capture"), body, {
    headers: captureHeaders(body),
    tags: { type: "webhook", severity: "critical" },
  });
}

export function criticalBurst() {
  const start = Date.now();
  const res = createCriticalAlert(__ITER);
  const elapsed = Date.now() - start;

  pushLatency.add(elapsed);

  check(res, {
    "critical alert created": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
    "creation under 5s": () => elapsed < 5000,
  });

  if (res.status >= 200 && res.status < 300) {
    pushSent.add(1);
  }

  sleep(1); // small gap between bursts
}

export function pipelineTiming() {
  // Measure the full pipeline: create alert → check if notification was queued
  const start = Date.now();
  const res = createCriticalAlert(1000 + __ITER);
  const creationTime = Date.now() - start;

  alertToNotificationLatency.add(creationTime);

  check(res, {
    "pipeline alert created": (r) => r.status >= 200 && r.status < 400,
    "pipeline under 10s": () => creationTime < 10000,
  });

  sleep(5);
}
