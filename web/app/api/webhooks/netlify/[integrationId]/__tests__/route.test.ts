/**
 * Tests for the Netlify webhook route handler.
 *
 * Mocks all side-effectful imports (DB, rate limiting, alerts, rollback)
 * and validates:
 *  - Payload parsing for Netlify deploy events
 *  - HMAC SHA256 signature verification
 *  - Alert creation with the correct shape
 *  - Auto-rollback dispatch with the right provider config
 *  - Rejection of invalid integration IDs, wrong services, missing secrets
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// ── Mocks (must be defined before importing the route) ─────────────────────

const mockLoadIntegration = vi.fn();
const mockCreateAlertIfNew = vi.fn();
const mockMarkIntegrationSuccess = vi.fn();
const mockCheckWebhookRateLimit = vi.fn();
const mockRateLimit = vi.fn();
const mockDecryptConfig = vi.fn();
const mockAutoAnalyzeAlert = vi.fn();
const mockTriggerProviderRollback = vi.fn();

vi.mock("@/lib/webhooks/shared", () => ({
  loadIntegration: mockLoadIntegration,
  createAlertIfNew: mockCreateAlertIfNew,
  markIntegrationSuccess: mockMarkIntegrationSuccess,
}));

vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: mockCheckWebhookRateLimit,
  extractClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: mockRateLimit,
}));

vi.mock("@/lib/db", () => ({
  PLAN_LIMITS: {
    free: { maxCaptureEventsPerDay: 1000 },
    pro: { maxCaptureEventsPerDay: 100000 },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decryptConfig: mockDecryptConfig,
}));

vi.mock("@/lib/ai/auto-analyze", () => ({
  autoAnalyzeAlert: mockAutoAnalyzeAlert,
}));

vi.mock("@/lib/services/auto-rollback", () => ({
  triggerProviderRollback: mockTriggerProviderRollback,
}));

// Import AFTER the mocks are set up
const { POST } = await import("../route");

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_INTEGRATION_ID = "11111111-2222-3333-4444-555555555555";
const TEST_SECRET = "test-webhook-secret-abc123";
const TEST_SITE_ID = "site-uuid-1234";

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function makeRequest(body: string, opts: { signature?: string; integrationId?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.signature) headers.set("x-webhook-signature", opts.signature);
  return new Request(`https://example.com/api/webhooks/netlify/${opts.integrationId ?? VALID_INTEGRATION_ID}`, {
    method: "POST",
    headers,
    body,
  });
}

function routeParams(integrationId = VALID_INTEGRATION_ID) {
  return { params: Promise.resolve({ integrationId }) };
}

function defaultIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_INTEGRATION_ID,
    service: "netlify",
    projectId: "proj-1",
    userPlan: "free" as const,
    webhookSecret: null,
    configEncrypted: Buffer.from("encrypted"),
    ...overrides,
  };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    token: "nfp_test_token",
    siteId: TEST_SITE_ID,
    alertConfig: { autoRollback: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckWebhookRateLimit.mockResolvedValue({ allowed: true });
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockDecryptConfig.mockReturnValue(defaultConfig());
  mockCreateAlertIfNew.mockResolvedValue({ id: "alert-999" });
  mockAutoAnalyzeAlert.mockResolvedValue(undefined);
  mockMarkIntegrationSuccess.mockResolvedValue(undefined);
  mockTriggerProviderRollback.mockResolvedValue(undefined);
});

// ── Integration ID validation ──────────────────────────────────────────────

describe("Netlify webhook — integration ID validation", () => {
  it("rejects malformed UUID", async () => {
    const res = await POST(makeRequest("{}", { integrationId: "not-a-uuid" }), routeParams("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("rejects missing integration", async () => {
    mockLoadIntegration.mockResolvedValue(null);
    const res = await POST(makeRequest("{}"), routeParams());
    expect(res.status).toBe(404);
  });

  it("rejects non-netlify integration", async () => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration({ service: "vercel" }));
    const res = await POST(makeRequest("{}"), routeParams());
    expect(res.status).toBe(400);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe("Netlify webhook — rate limiting", () => {
  it("rejects when IP rate limit exceeded", async () => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration());
    mockCheckWebhookRateLimit.mockResolvedValue({ allowed: false, retryAfter: 60 });
    const res = await POST(makeRequest("{}"), routeParams());
    expect(res.status).toBe(429);
  });

  it("rejects when daily cap exceeded", async () => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration());
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 3600 });
    const res = await POST(makeRequest("{}"), routeParams());
    expect(res.status).toBe(429);
  });
});

// ── HMAC signature verification ────────────────────────────────────────────

describe("Netlify webhook — signature verification", () => {
  beforeEach(() => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration({ webhookSecret: TEST_SECRET }));
  });

  it("accepts valid signature", async () => {
    const body = JSON.stringify({ state: "ready", name: "my-site" });
    const sig = sign(body, TEST_SECRET);
    const res = await POST(makeRequest(body, { signature: sig }), routeParams());
    expect(res.status).toBe(200);
  });

  it("rejects missing signature when secret is set", async () => {
    const body = JSON.stringify({ state: "ready" });
    const res = await POST(makeRequest(body), routeParams());
    expect(res.status).toBe(401);
  });

  it("rejects wrong signature", async () => {
    const body = JSON.stringify({ state: "ready" });
    const res = await POST(makeRequest(body, { signature: "sha256=deadbeef" }), routeParams());
    expect(res.status).toBe(401);
  });

  it("skips verification when no secret is configured", async () => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration({ webhookSecret: null }));
    const body = JSON.stringify({ state: "ready" });
    const res = await POST(makeRequest(body), routeParams());
    expect(res.status).toBe(200);
  });
});

// ── Payload parsing + alert creation ───────────────────────────────────────

describe("Netlify webhook — deploy.error", () => {
  beforeEach(() => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration());
  });

  it("creates a critical alert with full context", async () => {
    const payload = {
      id: "deploy-abc123",
      site_id: TEST_SITE_ID,
      name: "my-site",
      state: "error",
      error_message: "Build failed: Module not found: foo",
      commit_ref: "abc123def456",
      branch: "main",
      ssl_url: "https://my-site.netlify.app",
    };
    const body = JSON.stringify(payload);

    const res = await POST(makeRequest(body), routeParams());
    expect(res.status).toBe(200);

    expect(mockCreateAlertIfNew).toHaveBeenCalledTimes(1);
    const [alertData, projectId] = mockCreateAlertIfNew.mock.calls[0];
    expect(alertData).toMatchObject({
      severity: "critical",
      title: "[Netlify] Deploy failed — my-site",
      sourceIntegrations: ["netlify"],
      isRead: false,
      isResolved: false,
    });
    expect(alertData.body).toContain("State: error");
    expect(alertData.body).toContain("Deploy ID: deploy-abc123");
    expect(alertData.body).toContain("Branch: main");
    expect(alertData.body).toContain("Commit: abc123de");
    expect(alertData.body).toContain("URL: https://my-site.netlify.app");
    expect(alertData.body).toContain("Build failed: Module not found: foo");
    expect(projectId).toBe("proj-1");
  });

  it("handles building_failed state", async () => {
    const body = JSON.stringify({ state: "building_failed", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockCreateAlertIfNew).toHaveBeenCalled();
  });

  it("handles deploy_failed state", async () => {
    const body = JSON.stringify({ state: "deploy_failed", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockCreateAlertIfNew).toHaveBeenCalled();
  });

  it("does NOT create alert on state=ready", async () => {
    const body = JSON.stringify({ state: "ready", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });

  it("does NOT create alert on state=building", async () => {
    const body = JSON.stringify({ state: "building", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });
});

// ── Auto-rollback dispatch ─────────────────────────────────────────────────

describe("Netlify webhook — auto-rollback dispatch", () => {
  beforeEach(() => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration());
  });

  it("triggers rollback with correct provider config when enabled", async () => {
    const body = JSON.stringify({ state: "error", name: "my-site" });
    await POST(makeRequest(body), routeParams());

    expect(mockTriggerProviderRollback).toHaveBeenCalledTimes(1);
    expect(mockTriggerProviderRollback).toHaveBeenCalledWith({
      alertId: "alert-999",
      // projectId is now passed so the cooldown lock is keyed per-tenant
      // (LOW finding fix — projectName is user-controlled and can collide).
      projectId: "proj-1",
      providerConfig: {
        service: "netlify",
        token: "nfp_test_token",
        siteId: TEST_SITE_ID,
        projectName: "my-site",
      },
    });
  });

  it("does NOT trigger rollback when autoRollback is disabled", async () => {
    mockDecryptConfig.mockReturnValue(defaultConfig({ alertConfig: { autoRollback: false } }));
    const body = JSON.stringify({ state: "error", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockCreateAlertIfNew).toHaveBeenCalled();
    expect(mockTriggerProviderRollback).not.toHaveBeenCalled();
  });

  it("does NOT trigger rollback when token or siteId is missing", async () => {
    mockDecryptConfig.mockReturnValue(defaultConfig({ siteId: undefined }));
    const body = JSON.stringify({ state: "error", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockTriggerProviderRollback).not.toHaveBeenCalled();
  });

  it("triggers autoAnalyzeAlert for every alert", async () => {
    const body = JSON.stringify({ state: "error", name: "my-site" });
    await POST(makeRequest(body), routeParams());
    expect(mockAutoAnalyzeAlert).toHaveBeenCalledWith({ id: "alert-999" });
  });
});

// ── Bad payloads ────────────────────────────────────────────────────────────

describe("Netlify webhook — malformed input", () => {
  beforeEach(() => {
    mockLoadIntegration.mockResolvedValue(defaultIntegration());
  });

  it("rejects invalid JSON", async () => {
    const res = await POST(makeRequest("not json at all"), routeParams());
    expect(res.status).toBe(400);
  });

  it("rejects payload larger than 1MB", async () => {
    const huge = "x".repeat(1_000_001);
    const res = await POST(makeRequest(huge), routeParams());
    expect(res.status).toBe(413);
  });

  it("returns 200 for unknown state with no alert created", async () => {
    const body = JSON.stringify({ state: "something_new", name: "my-site" });
    const res = await POST(makeRequest(body), routeParams());
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });
});
