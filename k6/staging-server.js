/**
 * k6 Stress Test: InariWatch Staging Server
 *
 * Tests the staging orchestrator API at api.staging.inariwatch.com:
 * 1. Health endpoint responsiveness under load
 * 2. Deploy endpoint validation (auth, bad requests)
 * 3. Status endpoint for non-existent staging
 * 4. Auth enforcement (reject unauthorized requests)
 * 5. Concurrent health checks
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.STAGING_URL || "https://api.staging.inariwatch.com";
const API_SECRET = __ENV.STAGING_API_SECRET || "";

const errorRate = new Rate("errors");
const healthLatency = new Trend("health_latency", true);

export const options = {
  scenarios: {
    // Scenario 1: Health check burst
    health_burst: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "15s",
      preAllocatedVUs: 10,
      maxVUs: 20,
      exec: "healthCheck",
    },
    // Scenario 2: Auth enforcement
    auth_enforcement: {
      executor: "shared-iterations",
      vus: 3,
      iterations: 10,
      exec: "authEnforcement",
      startTime: "16s",
    },
    // Scenario 3: API validation
    api_validation: {
      executor: "shared-iterations",
      vus: 2,
      iterations: 8,
      exec: "apiValidation",
      startTime: "22s",
    },
  },
  thresholds: {
    errors: ["rate<0.05"],
    health_latency: ["p(95)<500"],
    http_req_duration: ["p(95)<2000"],
  },
};

function authHeaders() {
  return {
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      "Content-Type": "application/json",
    },
  };
}

// ── Scenario 1: Health endpoint under load ──────────────────────────────────

export function healthCheck() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/health`);
  healthLatency.add(Date.now() - start);

  const ok = check(res, {
    "health status 200": (r) => r.status === 200,
    "health returns ok:true": (r) => {
      try {
        return JSON.parse(r.body).ok === true;
      } catch {
        return false;
      }
    },
    "health has containers_max": (r) => {
      try {
        return JSON.parse(r.body).containers_max > 0;
      } catch {
        return false;
      }
    },
  });
  errorRate.add(!ok);
}

// ── Scenario 2: Auth enforcement ────────────────────────────────────────────

export function authEnforcement() {
  group("reject no auth", () => {
    const res = http.get(`${BASE_URL}/status/test-123`);
    check(res, {
      "no auth returns 401": (r) => r.status === 401,
    });
  });

  group("reject bad token", () => {
    const res = http.get(`${BASE_URL}/status/test-123`, {
      headers: { Authorization: "Bearer invalid-token-12345" },
    });
    check(res, {
      "bad token returns 403": (r) => r.status === 403,
    });
  });

  group("reject empty bearer", () => {
    const res = http.get(`${BASE_URL}/status/test-123`, {
      headers: { Authorization: "Bearer " },
    });
    check(res, {
      "empty bearer returns 401 or 403": (r) => r.status === 401 || r.status === 403,
    });
  });

  if (API_SECRET) {
    group("accept valid token", () => {
      const res = http.get(`${BASE_URL}/health`, authHeaders());
      check(res, {
        "valid token returns 200": (r) => r.status === 200,
      });
    });
  }

  sleep(0.5);
}

// ── Scenario 3: API validation ──────────────────────────────────────────────

export function apiValidation() {
  if (!API_SECRET) {
    console.warn("STAGING_API_SECRET not set — skipping authenticated tests");
    return;
  }

  group("status for non-existent staging", () => {
    const res = http.get(`${BASE_URL}/status/non-existent-id`, authHeaders());
    check(res, {
      "non-existent returns 404": (r) => r.status === 404,
    });
  });

  group("deploy with missing fields", () => {
    const res = http.post(`${BASE_URL}/deploy`, JSON.stringify({}), authHeaders());
    check(res, {
      "empty deploy returns 400": (r) => r.status === 400,
    });
  });

  group("deploy with partial fields", () => {
    const res = http.post(
      `${BASE_URL}/deploy`,
      JSON.stringify({ id: "test-partial", repo_url: "" }),
      authHeaders()
    );
    check(res, {
      "partial deploy returns 400": (r) => r.status === 400,
    });
  });

  group("verify non-existent staging", () => {
    const res = http.post(
      `${BASE_URL}/verify/non-existent-id`,
      JSON.stringify({ substrate_events: [], assertions: [] }),
      authHeaders()
    );
    check(res, {
      "verify non-existent returns 404": (r) => r.status === 404,
    });
  });

  group("delete non-existent staging", () => {
    const res = http.del(`${BASE_URL}/deploy/non-existent-id`, null, authHeaders());
    check(res, {
      "delete non-existent returns 204": (r) => r.status === 204,
    });
  });

  sleep(0.5);
}
