import crypto from "k6/crypto";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// ── Environment ─────────────────────────────────────────────────────────────

export const BASE_URL = __ENV.BASE_URL || "https://app.inariwatch.com";
export const CRON_SECRET = __ENV.CRON_SECRET || "";
export const API_TOKEN = __ENV.API_TOKEN || "";
export const INTEGRATION_ID = __ENV.INTEGRATION_ID || "";
export const WEBHOOK_SECRET = __ENV.WEBHOOK_SECRET || "";
export const CAPTURE_SECRET = __ENV.CAPTURE_SECRET || "";

// ── HMAC Signing ────────────────────────────────────────────────────────────

export function hmacSha256(secret, payload) {
  return crypto.hmac("sha256", secret, payload, "hex");
}

export function hmacSha1(secret, payload) {
  return crypto.hmac("sha1", secret, payload, "hex");
}

// ── Headers per integration ─────────────────────────────────────────────────

export function captureHeaders(payload) {
  const sig = hmacSha256(CAPTURE_SECRET, payload);
  return {
    "Content-Type": "application/json",
    "x-capture-signature": `sha256=${sig}`,
  };
}

export function sentryHeaders(payload) {
  const sig = hmacSha256(WEBHOOK_SECRET, payload);
  return {
    "Content-Type": "application/json",
    "sentry-hook-signature": sig,
    "sentry-hook-resource": "event_alert",
  };
}

export function vercelHeaders(payload) {
  const sig = hmacSha1(WEBHOOK_SECRET, payload);
  return {
    "Content-Type": "application/json",
    "x-vercel-signature": sig,
  };
}

export function githubHeaders(payload) {
  const sig = hmacSha256(WEBHOOK_SECRET, payload);
  return {
    "Content-Type": "application/json",
    "x-hub-signature-256": `sha256=${sig}`,
    "x-github-event": "check_run",
  };
}

export function datadogHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${WEBHOOK_SECRET}`,
  };
}

export function expoHeaders(payload) {
  const sig = hmacSha256(WEBHOOK_SECRET, payload);
  return {
    "Content-Type": "application/json",
    "expo-signature": sig,
  };
}

export function mcpHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_TOKEN}`,
  };
}

export function cronHeaders() {
  return {
    Authorization: `Bearer ${CRON_SECRET}`,
  };
}

// ── Payload Generators ──────────────────────────────────────────────────────

const ERROR_MESSAGES = [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  "ReferenceError: process is not defined",
  "Error: ECONNREFUSED 127.0.0.1:5432",
  "SyntaxError: Unexpected token '<' in JSON at position 0",
  "Error: Request failed with status code 500",
  "TypeError: fetch failed - ENOTFOUND api.example.com",
  "Error: ENOMEM - not enough memory",
  "RangeError: Maximum call stack size exceeded",
  "Error: ETIMEOUT - connection timed out after 30000ms",
  "TypeError: Cannot convert undefined or null to object",
  "Error: ENOSPC: no space left on device",
  "Error: certificate has expired",
  "MongoNetworkError: connection 5 to cluster0.mongodb.net closed",
  "Error: P1001 - Can't reach database server",
  "Error: 429 Too Many Requests - rate limit exceeded",
];

const STACK_TRACES = [
  "at UserList (src/components/UserList.tsx:42:15)\nat renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)",
  "at processTicksAndRejections (node:internal/process/task_queues:95:5)\nat async handler (src/pages/api/users.ts:23:10)",
  "at Object.getServerSideProps (src/pages/dashboard.tsx:67:22)\nat renderToHTML (node_modules/next/dist/server/render.js:442:24)",
  "at Pool.query (node_modules/pg/lib/pool.js:54:9)\nat getUser (src/lib/db.ts:89:20)",
  "at async fetchData (src/lib/api.ts:15:18)\nat async Dashboard (src/app/dashboard/page.tsx:28:20)",
];

export function capturePayload(unique = true) {
  const msg = ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)];
  const stack = STACK_TRACES[Math.floor(Math.random() * STACK_TRACES.length)];
  const title = unique ? `${msg} [${uuidv4().slice(0, 8)}]` : msg;

  return JSON.stringify({
    fingerprint: crypto.sha256(title, "hex"),
    title,
    body: `${title}\n${stack}`,
    severity: Math.random() > 0.7 ? "critical" : "warning",
    timestamp: new Date().toISOString(),
    environment: "production",
    release: `1.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 100)}`,
    runtime: "nodejs",
    tags: { service: "k6-stress-test" },
  });
}

export function sentryPayload(unique = true) {
  const msg = ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)];
  const title = unique ? `${msg} [${uuidv4().slice(0, 8)}]` : msg;

  return JSON.stringify({
    action: "created",
    data: {
      event: {
        event_id: uuidv4(),
        title,
        message: title,
        level: "error",
        platform: "node",
        timestamp: Date.now() / 1000,
        tags: [["environment", "production"]],
      },
      triggered_rule: "k6 stress test rule",
    },
  });
}

export function vercelPayload() {
  return JSON.stringify({
    type: "deployment.error",
    payload: {
      deployment: {
        id: `dpl_${uuidv4().replace(/-/g, "").slice(0, 20)}`,
        url: `my-app-${uuidv4().slice(0, 8)}.vercel.app`,
        name: "my-app",
        meta: { githubCommitMessage: "fix: update deps" },
      },
      error: { message: "Build failed: Module not found", code: "BUILD_FAILED" },
    },
    createdAt: Date.now(),
  });
}

export function githubPayload() {
  return JSON.stringify({
    action: "completed",
    check_run: {
      id: Math.floor(Math.random() * 999999999),
      name: "build-and-test",
      status: "completed",
      conclusion: "failure",
      output: {
        title: "CI Failed",
        summary: "3 tests failed",
        text: "FAIL src/__tests__/api.test.ts\n  Expected 200, received 500",
      },
      html_url: `https://github.com/test-org/test-repo/runs/${Math.floor(Math.random() * 999999)}`,
    },
    repository: { full_name: "test-org/test-repo", html_url: "https://github.com/test-org/test-repo" },
  });
}

export function datadogPayload() {
  return JSON.stringify({
    id: uuidv4(),
    title: `[k6] High error rate on api-gateway`,
    text: "Error rate exceeded 5% threshold for 10 minutes",
    date: Math.floor(Date.now() / 1000),
    priority: "normal",
    tags: ["env:production", "service:api-gateway"],
    alert_type: "error",
  });
}

export function expoPayload() {
  return JSON.stringify({
    id: uuidv4(),
    platform: "android",
    status: "errored",
    artifacts: {},
    error: { message: "Build failed: Gradle build error", errorCode: "BUILD_FAILED" },
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
}

export function mcpPayload(toolName, args = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 999999),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
}

// ── Utility ─────────────────────────────────────────────────────────────────

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function webhookUrl(integration) {
  return `${BASE_URL}/api/webhooks/${integration}/${INTEGRATION_ID}`;
}
