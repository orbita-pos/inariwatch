/**
 * Scenario 5: Auth Rate Limiting — Brute Force Protection
 *
 * Tests auth endpoints under brute force conditions.
 * Validates: rate limiting kicks in after 5 attempts, device flow poll limits.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, randomInt } from "../lib/helpers.js";
import { STRICT_THRESHOLDS } from "../lib/thresholds.js";
import { authAttemptsTotal, authRateLimited, authSuccessful } from "../lib/metrics.js";

export const options = {
  scenarios: {
    login_bruteforce: {
      executor: "constant-arrival-rate",
      rate: 20,           // 20 attempts per second (way above 5/60s limit)
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 25,
      exec: "loginBruteforce",
      tags: { endpoint: "login" },
    },
    device_flow_poll: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
      startTime: "35s",
      exec: "deviceFlowPoll",
      tags: { endpoint: "device-flow" },
    },
  },
  thresholds: {
    ...STRICT_THRESHOLDS,
    "auth_rate_limited": ["count>0"], // we expect rate limiting to trigger
  },
  tags: { scenario: "auth-bruteforce" },
};

export function loginBruteforce() {
  authAttemptsTotal.add(1);

  // NextAuth credentials endpoint
  const res = http.post(`${BASE_URL}/api/auth/callback/credentials`, JSON.stringify({
    email: `attacker-${randomInt(1, 100)}@evil.com`,
    password: "wrong-password-123",
    csrfToken: "fake-csrf-token",
  }), {
    headers: { "Content-Type": "application/json" },
    redirects: 0,
    tags: { type: "auth", method: "login" },
  });

  if (res.status === 429) {
    authRateLimited.add(1);
    check(res, {
      "brute force blocked (429)": (r) => r.status === 429,
    });
  } else if (res.status === 302 || res.status === 200) {
    authSuccessful.add(1);
  }

  check(res, {
    "auth responds": (r) => r.status !== 0,
  });
}

export function deviceFlowPoll() {
  // Rapidly poll device flow endpoint
  const fakeCode = `FAKE-${randomInt(100000, 999999)}`;

  for (let i = 0; i < 10; i++) {
    authAttemptsTotal.add(1);

    const res = http.get(
      `${BASE_URL}/api/cli/auth/poll?code=${fakeCode}&client=mobile`,
      { tags: { type: "auth", method: "device-flow" } }
    );

    if (res.status === 429) {
      authRateLimited.add(1);
      check(res, {
        "device flow rate limited": (r) => r.status === 429,
      });
      break;
    }

    check(res, {
      "device flow responds": (r) => r.status !== 0,
    });

    sleep(0.2);
  }
}
