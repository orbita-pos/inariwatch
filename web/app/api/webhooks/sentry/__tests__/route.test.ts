import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn().mockImplementation((body, init) => {
      return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: init?.headers,
      });
    }),
  },
}));

import { POST } from "../[integrationId]/route";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLoadIntegration = vi.fn();
const mockVerifySignature = vi.fn().mockReturnValue(true);
const mockCreateAlertIfNew = vi.fn().mockResolvedValue({ id: "alert-1" });
const mockMarkIntegrationSuccess = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/webhooks/shared", () => ({
  loadIntegration: (...args: unknown[]) => mockLoadIntegration(...args),
  verifySignature: (...args: unknown[]) => mockVerifySignature(...args),
  createAlertIfNew: (...args: unknown[]) => mockCreateAlertIfNew(...args),
  markIntegrationSuccess: (...args: unknown[]) => mockMarkIntegrationSuccess(...args),
}));

const mockCheckRateLimit = vi.fn().mockReturnValue({ allowed: true });
vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockAutoAnalyzeAlert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/ai/auto-analyze", () => ({
  autoAnalyzeAlert: (...args: unknown[]) => mockAutoAnalyzeAlert(...args),
}));

const mockDecryptConfig = vi.fn();
vi.mock("@/lib/crypto", () => ({
  decryptConfig: (...args: unknown[]) => mockDecryptConfig(...args),
}));

// Mock global fetch for Sentry API (stack trace retrieval)
const mockFetch = vi.fn();
global.fetch = mockFetch;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(resource: string, payload: unknown, signatureOveride?: string) {
  const body = JSON.stringify(payload);
  const signature = signatureOveride ?? crypto.createHmac("sha256", "secret").update(body).digest("hex");
  
  return new Request("https://demo.com", {
    method: "POST",
    headers: {
      "x-forwarded-for": "127.0.0.1",
      "sentry-hook-resource": resource,
      "sentry-hook-signature": signature,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockLoadIntegration.mockResolvedValue({
    id: "integ-1",
    service: "sentry",
    projectId: "proj-1",
    webhookSecret: "secret",
  });

  mockDecryptConfig.mockReturnValue({
    alertConfig: {
      new_issues: { enabled: true },
      regressions: { enabled: true },
    },
    token: "sentry_token_123",
    org: "my-org",
  });

  // Default fetch mock for stack trace
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      entries: [
        {
          type: "exception",
          data: {
            values: [{
              type: "TypeError",
              value: "Cannot read properties of undefined",
              stacktrace: {
                frames: [
                  { filename: "app.ts", function: "main", lineNo: 42 }
                ]
              }
            }]
          }
        }
      ]
    })
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Sentry Webhook POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Sentry Webhook POST (/api/webhooks/sentry/[id])", () => {
  
  // ── Authentication & Infrastructure ────────────────────────────────────

  it("returns 429 if rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 30 });
    const req = makeRequest("ping", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(429);
  });

  it("returns 404 if integration not found", async () => {
    mockLoadIntegration.mockResolvedValueOnce(null);
    const req = makeRequest("ping", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 if wrong integration type", async () => {
    mockLoadIntegration.mockResolvedValueOnce({ service: "github" });
    const req = makeRequest("ping", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 401 if signature is invalid", async () => {
    mockVerifySignature.mockReturnValueOnce(false);
    const req = makeRequest("ping", {}, "bad-sig");
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(401);
  });

  // ── Events: New Issue ───────────────────────────────────────────────

  it("creates a warning alert for new issue and fetches stack trace", async () => {
    const payload = {
      action: "created",
      data: {
        issue: {
          id: "999",
          title: "TypeError in Component",
          culprit: "pages/index.tsx",
          count: 5,
          userCount: 2,
          project: { slug: "web-frontend" }
        }
      }
    };
    
    const req = makeRequest("issue", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://sentry.io/api/0/issues/999/events/latest/",
      expect.objectContaining({ headers: { Authorization: "Bearer sentry_token_123" } })
    );

    const callArgs = mockCreateAlertIfNew.mock.calls[0][0];
    expect(callArgs.severity).toBe("warning");
    expect(callArgs.title).toBe("[New Issue] TypeError in Component");
    expect(callArgs.body).toContain("pages/index.tsx");
    expect(callArgs.body).toContain("5 events · 2 user(s) affected");
    expect(callArgs.body).toContain("Stack trace:\nTypeError: Cannot read properties of undefined\n  at main (app.ts:42)");
    
    expect(mockAutoAnalyzeAlert).toHaveBeenCalled();
  });

  it("skips new issues if disabled in config", async () => {
    mockDecryptConfig.mockReturnValueOnce({
      alertConfig: { new_issues: { enabled: false } },
    });
    const payload = { action: "created" };
    
    const req = makeRequest("issue", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("new_issues disabled");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });

  // ── Events: Regressions ──────────────────────────────────────────────

  it("creates a critical alert for a regression issue", async () => {
    const payload = {
      action: "regression", // OR "unresolved" with isRegression = true
      data: {
        issue: { id: "888", title: "DB Timeout" }
      }
    };
    
    const req = makeRequest("issue", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    const callArgs = mockCreateAlertIfNew.mock.calls[0][0];
    expect(callArgs.severity).toBe("critical");
    expect(callArgs.title).toBe("[Regression] DB Timeout");
    expect(callArgs.body).toContain("was previously resolved but has reappeared");
  });

  // ── Events: Metric Alerts ──────────────────────────────────────────────

  it("creates a warning alert for event_alert (metric triggers)", async () => {
    const payload = {
      action: "triggered",
      data: {
        triggered_rule: "High latency trigger",
        event: {
          title: "Response > 500ms",
          message: "API is slow"
        }
      }
    };
    
    const req = makeRequest("event_alert", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    const callArgs = mockCreateAlertIfNew.mock.calls[0][0];
    expect(callArgs.severity).toBe("warning");
    expect(callArgs.title).toBe("[Sentry Alert] Response > 500ms");
    expect(callArgs.body).toBe("API is slow");
  });

  // ── Edge Cases ─────────────────────────────────────────────────────────

  it("handles missing Sentry API tokens gracefully (no stack trace, but alert still fires)", async () => {
    mockDecryptConfig.mockReturnValueOnce({ alertConfig: {}, token: undefined, org: undefined });
    const payload = { action: "created" };
    
    const req = makeRequest("issue", payload);
    await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(mockFetch).not.toHaveBeenCalled(); // No token, so we skip fetch
    expect(mockCreateAlertIfNew).toHaveBeenCalled(); // Alert is still created
  });

  it("handles Sentry API failures gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network Error"));
    const payload = { action: "created", data: { issue: { id: "999" } } };
    
    const req = makeRequest("issue", payload);
    await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    const callArgs = mockCreateAlertIfNew.mock.calls[0][0];
    // Stack trace is missing but alert was created
    expect(callArgs.body).not.toContain("Stack trace:");
  });
});
