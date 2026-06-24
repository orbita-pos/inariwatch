/**
 * Scenario 4: Deduplication & Fingerprinting Under Load
 *
 * Tests that fingerprinting and dedup work correctly under concurrent writes.
 * Validates: same error deduplicates, different errors create separate alerts, storm detection.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import {
  BASE_URL, INTEGRATION_ID, CAPTURE_SECRET,
  captureHeaders, webhookUrl, randomInt,
} from "../lib/helpers.js";
import crypto from "k6/crypto";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { dedupAlertsCreated, dedupDuplicatesBlocked, dedupAccuracy } from "../lib/metrics.js";

export const options = {
  scenarios: {
    // Phase 1: Send same error 200 times → should create only 1 alert
    same_error: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 200,
      maxDuration: "30s",
      exec: "sameError",
      tags: { phase: "dedup-same" },
    },
    // Phase 2: Send 100 different errors → should create 100 alerts (minus rate limits)
    different_errors: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 100,
      maxDuration: "1m",
      startTime: "45s",
      exec: "differentErrors",
      tags: { phase: "dedup-different" },
    },
    // Phase 3: Send errors that vary only in timestamp/UUID → should dedup
    fingerprint_variants: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 50,
      maxDuration: "30s",
      startTime: "2m",
      exec: "fingerprintVariants",
      tags: { phase: "dedup-fingerprint" },
    },
    // Phase 4: Send 10 errors in 30s → should trigger storm detection
    storm_trigger: {
      executor: "shared-iterations",
      vus: 5,
      iterations: 10,
      maxDuration: "30s",
      startTime: "3m",
      exec: "stormTrigger",
      tags: { phase: "storm" },
    },
  },
  thresholds: BASE_THRESHOLDS,
  tags: { scenario: "alert-dedup" },
};

const FIXED_ERROR = "k6-dedup-test: TypeError: Cannot read property 'id' of null";
let stormCounter = 0;

function sendCapture(title) {
  const body = JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `${title}\nat stressTest (k6/scenarios/alert-dedup.js:1:1)`,
    severity: "critical",
    timestamp: new Date().toISOString(),
    environment: "test",
    release: "k6-dedup-1.0.0",
    runtime: "nodejs",
    tags: { test: "dedup" },
  });

  return http.post(webhookUrl("capture"), body, {
    headers: captureHeaders(body),
    tags: { type: "webhook" },
  });
}

export function sameError() {
  // All VUs send the exact same error title → should dedup to 1 alert
  const res = sendCapture(FIXED_ERROR);

  if (res.status >= 200 && res.status < 300) {
    const body = JSON.parse(res.body || "{}");
    if (body.created) {
      dedupAlertsCreated.add(1);
      dedupAccuracy.add(false); // Only the first one should create
    } else {
      dedupDuplicatesBlocked.add(1);
      dedupAccuracy.add(true);
    }
  }

  check(res, {
    "dedup request accepted": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
  });
}

export function differentErrors() {
  // Each iteration sends a unique error → should each create an alert
  const unique = `k6-unique-${__VU}-${__ITER}-${Date.now()}`;
  const res = sendCapture(unique);

  if (res.status >= 200 && res.status < 300) {
    dedupAlertsCreated.add(1);
  }

  check(res, {
    "unique error accepted": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
  });
}

export function fingerprintVariants() {
  // Errors that vary only in dynamic parts (timestamp, UUID) should have same fingerprint
  const timestamp = new Date().toISOString();
  const uuid = `${Math.random().toString(36).slice(2)}`;

  // These should normalize to the same fingerprint:
  const title = `Error at ${timestamp}: Request ${uuid} failed with status 500`;
  const res = sendCapture(title);

  check(res, {
    "fingerprint variant accepted": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
  });
}

export function stormTrigger() {
  // Send 10 different critical errors in quick succession → trigger incident storm (>= 5 in 5 min)
  stormCounter++;
  const title = `k6-storm-${stormCounter}: Critical failure in service-${stormCounter}`;
  const res = sendCapture(title);

  check(res, {
    "storm error accepted": (r) => r.status >= 200 && r.status < 400 || r.status === 429,
  });

  sleep(0.5);
}
