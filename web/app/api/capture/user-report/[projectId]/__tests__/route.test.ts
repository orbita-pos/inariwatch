/**
 * Integration tests for POST /api/capture/user-report/[projectId].
 *
 * Mocks every side-effectful import (auth, rate limiting, service) so the
 * tests exercise the route handler verbatim: bearer parsing, URL match
 * defense, payload validation, body-size caps, and the response shape.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockLoadIntegrationByToken = vi.fn();
const mockIsProjectTokenSecret   = vi.fn();
const mockExtractClientIp        = vi.fn(() => "127.0.0.1");
const mockCheckWebhookRateLimit  = vi.fn();
const mockRateLimit              = vi.fn();
const mockCreateVisualReport     = vi.fn();
const mockExtractSessionId       = vi.fn(() => null);

vi.mock("@/lib/webhooks/shared", () => ({
  loadIntegrationByToken: mockLoadIntegrationByToken,
  isProjectTokenSecret:   mockIsProjectTokenSecret,
}));

vi.mock("@/lib/webhooks/rate-limit", () => ({
  extractClientIp:       mockExtractClientIp,
  checkWebhookRateLimit: mockCheckWebhookRateLimit,
}));

vi.mock("@/lib/auth-rate-limit", () => ({
  rateLimit: mockRateLimit,
}));

vi.mock("@/lib/services/visual-reports.service", () => ({
  createVisualReport: mockCreateVisualReport,
}));

vi.mock("@/lib/fulltrace/session-header", () => ({
  extractSessionId: mockExtractSessionId,
}));

const { POST } = await import("../route");

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const VALID_BEARER     = "iwk_pub_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function routeParams(projectId = VALID_PROJECT_ID) {
  return { params: Promise.resolve({ projectId }) };
}

function makeRequest(opts: {
  body?:        string | object;
  bearer?:      string | null;
  projectId?:   string;
  contentLength?: number;
} = {}): Request {
  const url = `https://example.com/api/capture/user-report/${opts.projectId ?? VALID_PROJECT_ID}`;
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.bearer !== null) {
    headers.set("authorization", `Bearer ${opts.bearer ?? VALID_BEARER}`);
  }
  const bodyStr = typeof opts.body === "string"
    ? opts.body
    : JSON.stringify(opts.body ?? validBody());
  if (opts.contentLength !== undefined) {
    headers.set("content-length", String(opts.contentLength));
  } else {
    headers.set("content-length", String(Buffer.byteLength(bodyStr, "utf8")));
  }
  return new Request(url, { method: "POST", headers, body: bodyStr });
}

function validBody() {
  return {
    screenshot:  "data:image/webp;base64," + "A".repeat(64),
    bundle:      { dom: "<div/>", state: { count: 0 } },
    description: "modal won't close on outside click",
    captureMs:   142,
    payloadSize: 118_443,
    redactionStats: { emails: 2, tokens: 0 },
  };
}

function happyPathSubject() {
  return {
    projectId:     VALID_PROJECT_ID,
    userPlan:      "free",
    integrationId: null,
    webhookSecret: null,
    tokenId:       "tok-1",
    workspaceId:   "ws-1",
    authMode:      "token",
  };
}

// ── Default mock behavior — reset every test ───────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockIsProjectTokenSecret.mockImplementation((s: string) => s?.startsWith("iwk_pub_v1_") ?? false);
  mockExtractClientIp.mockReturnValue("127.0.0.1");
  mockCheckWebhookRateLimit.mockResolvedValue({ allowed: true });
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockLoadIntegrationByToken.mockResolvedValue(happyPathSubject());
  mockCreateVisualReport.mockResolvedValue({
    reportId:   "report-1",
    alertId:    "alert-1",
    bundleHash: "deadbeef".repeat(8),
    deduped:    false,
  });
  mockExtractSessionId.mockReturnValue(null);
});

describe("POST /api/capture/user-report/[projectId]", () => {
  it("rejects 400 when projectId is not a UUID", async () => {
    const res = await POST(makeRequest({ projectId: "not-a-uuid" }), routeParams("not-a-uuid"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/project ID/i);
  });

  it("rejects 401 when bearer header is missing", async () => {
    const res = await POST(makeRequest({ bearer: null }), routeParams());
    expect(res.status).toBe(401);
  });

  it("rejects 401 when bearer is not an iwk_pub_v1_ token", async () => {
    const res = await POST(makeRequest({ bearer: "garbage-token" }), routeParams());
    expect(res.status).toBe(401);
    expect(mockLoadIntegrationByToken).not.toHaveBeenCalled();
  });

  it("rejects 401 when token lookup returns null", async () => {
    mockLoadIntegrationByToken.mockResolvedValue(null);
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(401);
  });

  it("rejects 401 when token projectId doesn't match URL projectId", async () => {
    mockLoadIntegrationByToken.mockResolvedValue({
      ...happyPathSubject(),
      projectId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    });
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/match/i);
  });

  it("rejects 413 when Content-Length exceeds 500KB", async () => {
    const res = await POST(
      makeRequest({ contentLength: 600_000 }),
      routeParams(),
    );
    expect(res.status).toBe(413);
  });

  it("rejects 429 when IP rate limit fires", async () => {
    mockCheckWebhookRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("rejects 429 when per-minute project rate limit fires", async () => {
    // First call (minute) returns blocked
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 45 });
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
  });

  it("rejects 429 when per-day project rate limit fires", async () => {
    // Minute pass, day blocked
    mockRateLimit
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(429);
  });

  it("rejects 400 on invalid JSON body", async () => {
    const res = await POST(makeRequest({ body: "{not-json" }), routeParams());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/JSON/i);
  });

  it("rejects 400 when screenshot is missing", async () => {
    const res = await POST(
      makeRequest({ body: { bundle: { dom: "<div/>" } } }),
      routeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects 400 when screenshot is not a data: URI or https:// URL", async () => {
    const res = await POST(
      makeRequest({
        body: {
          screenshot: "javascript:alert(1)",
          bundle: { dom: "<div/>" },
        },
      }),
      routeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects 400 when bundle is missing", async () => {
    const res = await POST(
      makeRequest({
        body: { screenshot: "data:image/webp;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      }),
      routeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("happy path → 200 with reportId/alertId/bundleHash, deduped=false", async () => {
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.reportId).toBe("report-1");
    expect(json.alertId).toBe("alert-1");
    expect(json.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(json.deduped).toBe(false);
    expect(mockCreateVisualReport).toHaveBeenCalledTimes(1);
    const args = mockCreateVisualReport.mock.calls[0][0];
    expect(args.projectId).toBe(VALID_PROJECT_ID);
    expect(args.description).toBe("modal won't close on outside click");
  });

  it("returns deduped:true when the service signals a dedup hit", async () => {
    mockCreateVisualReport.mockResolvedValue({
      reportId:   "report-1",
      alertId:    "alert-1",
      bundleHash: "deadbeef".repeat(8),
      deduped:    true,
    });
    const res = await POST(makeRequest(), routeParams());
    const json = await res.json();
    expect(json.deduped).toBe(true);
  });

  it("returns suppressed:true when service returns null (maintenance window)", async () => {
    mockCreateVisualReport.mockResolvedValue(null);
    const res = await POST(makeRequest(), routeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.suppressed).toBe(true);
    expect(json.reportId).toBeNull();
  });

  it("clamps description to 1000 characters", async () => {
    await POST(
      makeRequest({
        body: { ...validBody(), description: "x".repeat(2000) },
      }),
      routeParams(),
    );
    const args = mockCreateVisualReport.mock.calls[0][0];
    expect(args.description.length).toBeLessThanOrEqual(1000);
  });
});
