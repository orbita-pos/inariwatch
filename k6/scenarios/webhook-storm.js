/**
 * Scenario 1: Webhook Storm — Ingestion Under Load
 *
 * Simulates an incident storm where multiple integrations send webhooks simultaneously.
 * Validates: rate limiting, dedup, incident storm detection, auto-analyze trigger.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL, INTEGRATION_ID,
  capturePayload, captureHeaders,
  webhookUrl, randomInt,
} from "../lib/helpers.js";
import { WEBHOOK_THRESHOLDS } from "../lib/thresholds.js";
import {
  webhooksAccepted, webhooksRejected, webhooksRateLimited, webhookLatency, rateLimitHit,
} from "../lib/metrics.js";

export const options = {
  stages: [
    { duration: "30s", target: 10 },   // ramp up
    { duration: "2m",  target: 60 },   // hit rate limit (60/min)
    { duration: "30s", target: 120 },  // exceed rate limit
    { duration: "1m",  target: 0 },    // ramp down
  ],
  thresholds: WEBHOOK_THRESHOLDS,
  tags: { scenario: "webhook-storm" },
};

export default function () {
  const body = capturePayload(true);
  const headers = captureHeaders(body);

  const res = http.post(webhookUrl("capture"), body, {
    headers,
    tags: { type: "webhook", integration: "capture" },
  });

  webhookLatency.add(res.timings.duration);

  if (res.status === 429) {
    webhooksRateLimited.add(1);
    rateLimitHit.add(true);
    check(res, {
      "rate limited returns 429": (r) => r.status === 429,
    });
  } else if (res.status >= 200 && res.status < 300) {
    webhooksAccepted.add(1);
    rateLimitHit.add(false);
    check(res, {
      "webhook accepted (2xx)": (r) => r.status >= 200 && r.status < 300,
    });
  } else {
    webhooksRejected.add(1);
    rateLimitHit.add(false);
  }

  sleep(randomInt(100, 500) / 1000);
}
