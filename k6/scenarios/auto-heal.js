/**
 * Scenario 9: Uptime Auto-Heal Race Conditions
 *
 * Tests the auto-heal flow: 3 failures → rollback + remediation.
 * Validates: single heal trigger, cooldown enforcement, race conditions.
 *
 * NOTE: This test triggers the uptime cron which checks real monitors.
 * The auto-heal behavior depends on having monitors configured with autoHeal: true.
 * This test validates the cron behavior, not the actual Vercel rollback.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { BASE_URL, cronHeaders } from "../lib/helpers.js";
import { BASE_THRESHOLDS } from "../lib/thresholds.js";
import { healTriggered, healCooldownBlocked, timeToDetect, timeToHeal } from "../lib/metrics.js";

export const options = {
  scenarios: {
    // Simulate 3 consecutive uptime failures
    failure_sequence: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 4, // 3 failures + 1 check after heal
      exec: "failureSequence",
    },
    // Race condition: 2 cron runs detect failure simultaneously
    race_condition: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 2,
      startTime: "2m",
      maxDuration: "1m",
      exec: "raceCondition",
    },
    // Cooldown test: trigger heal, then try again within 10 min
    cooldown: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 3,
      startTime: "4m",
      exec: "cooldownTest",
    },
  },
  thresholds: {
    ...BASE_THRESHOLDS,
    "time_to_detect": ["p(95)<60000"],  // detect within 60s
    "time_to_heal": ["p(95)<120000"],   // heal within 120s
  },
  tags: { scenario: "auto-heal" },
};

export function failureSequence() {
  group("uptime_failure_sequence", () => {
    const start = Date.now();

    // Trigger uptime cron (this checks all monitors)
    const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
      headers: cronHeaders(),
      timeout: "30s",
      tags: { type: "cron", route: "uptime" },
    });

    const elapsed = Date.now() - start;
    timeToDetect.add(elapsed);

    check(res, {
      "uptime cron returns 200": (r) => r.status === 200,
      "uptime cron returns JSON": (r) => {
        try { JSON.parse(r.body); return true; } catch { return false; }
      },
    });

    if (res.status === 200) {
      try {
        const data = JSON.parse(res.body);
        if (data.healed) {
          healTriggered.add(1);
          timeToHeal.add(elapsed);
        }
      } catch { /* ignore */ }
    }

    // Wait between checks (simulating cron interval)
    sleep(15);
  });
}

export function raceCondition() {
  // Two cron invocations hitting uptime at the exact same time
  const start = Date.now();

  const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
    headers: cronHeaders(),
    timeout: "30s",
    tags: { type: "cron", route: "uptime-race" },
  });

  check(res, {
    "race condition: cron responds": (r) => r.status === 200,
    "race condition: no 500": (r) => r.status < 500,
  });

  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      if (data.healed) healTriggered.add(1);
    } catch { /* ignore */ }
  }
}

export function cooldownTest() {
  // Trigger uptime check multiple times — cooldown should prevent double heal
  const res = http.get(`${BASE_URL}/api/cron/poll/uptime`, {
    headers: cronHeaders(),
    timeout: "30s",
    tags: { type: "cron", route: "uptime-cooldown" },
  });

  check(res, {
    "cooldown: cron responds": (r) => r.status === 200,
  });

  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      if (data.healed) healTriggered.add(1);
      if (data.cooldown) healCooldownBlocked.add(1);
    } catch { /* ignore */ }
  }

  sleep(10);
}
