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
const mockMarkIntegrationSuccess = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/webhooks/shared", () => ({
  loadIntegration: (...args: unknown[]) => mockLoadIntegration(...args),
  verifySignature: (...args: unknown[]) => mockVerifySignature(...args),
  markIntegrationSuccess: (...args: unknown[]) => mockMarkIntegrationSuccess(...args),
}));

const mockCheckRateLimit = vi.fn().mockReturnValue({ allowed: true });
vi.mock("@/lib/webhooks/rate-limit", () => ({
  checkWebhookRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  extractClientIp: () => "127.0.0.1",
}));

const mockPublish = vi.fn().mockResolvedValue({ sessionId: "sess-1", subscribers: 1 });
const mockIsCiWebhookEnabled = vi.fn().mockReturnValue(true);
vi.mock("@/lib/ai/ci-webhook", () => ({
  publishCiCompletion: (...args: unknown[]) => mockPublish(...args),
  isCiWebhookEnabled: () => mockIsCiWebhookEnabled(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ID = "11111111-2222-3333-4444-555555555555";

function makeRequest(
  event: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Request {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("hex");
  return new Request("https://example.com", {
    method: "POST",
    headers: {
      "x-forwarded-for": "127.0.0.1",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
      "x-github-delivery": "abc-123",
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCiWebhookEnabled.mockReturnValue(true);
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockVerifySignature.mockReturnValue(true);
  mockLoadIntegration.mockResolvedValue({
    id: VALID_ID,
    service: "github",
    projectId: "proj-1",
    webhookSecret: "secret",
  });
  mockPublish.mockResolvedValue({ sessionId: "sess-1", subscribers: 1 });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Check-Run Webhook POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("GitHub check-run webhook POST", () => {
  // ── Input validation ──────────────────────────────────────────────────

  it("rejects non-UUID integration id with 400", async () => {
    const req = makeRequest("check_run", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "not-a-uuid" }) });
    expect(res.status).toBe(400);
  });

  it("short-circuits with skipped: disabled when CI_WEBHOOK_MODE is off", async () => {
    mockIsCiWebhookEnabled.mockReturnValueOnce(false);
    const req = makeRequest("check_run", { action: "completed", check_run: { head_sha: "x" } });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toMatch(/disabled/);
    expect(mockLoadIntegration).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── Rate limiting ─────────────────────────────────────────────────────

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 45 });
    const req = makeRequest("check_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  // ── Integration lookup ────────────────────────────────────────────────

  it("returns 404 when integration not found", async () => {
    mockLoadIntegration.mockResolvedValueOnce(null);
    const req = makeRequest("check_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when integration is not github service", async () => {
    mockLoadIntegration.mockResolvedValueOnce({ service: "vercel", webhookSecret: "s" });
    const req = makeRequest("check_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(400);
  });

  it("returns 403 when integration has no webhook secret configured", async () => {
    mockLoadIntegration.mockResolvedValueOnce({ service: "github", webhookSecret: null });
    const req = makeRequest("check_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(403);
  });

  // ── Authentication (the security-critical path) ───────────────────────

  it("returns 401 when signature header is missing", async () => {
    const body = JSON.stringify({ action: "completed" });
    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "x-github-event": "check_run" },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    mockVerifySignature.mockReturnValueOnce(false);
    const req = makeRequest("check_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(401);
  });

  it("calls verifySignature with sha256 algorithm and the raw body", async () => {
    const req = makeRequest("check_run", {
      action: "completed",
      check_run: { head_sha: "abc1234def5678", conclusion: "success" },
    });
    await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(mockVerifySignature).toHaveBeenCalled();
    const [, , secret, algo] = mockVerifySignature.mock.calls[0];
    expect(secret).toBe("secret");
    expect(algo).toBe("sha256");
  });

  it("returns 413 when payload exceeds 1MB", async () => {
    const large = "x".repeat(1_000_001);
    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=irrelevant", "x-github-event": "check_run" },
      body: large,
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(413);
  });

  // ── Event / action filtering ──────────────────────────────────────────

  it("skips non-check_run events without publishing", async () => {
    const req = makeRequest("workflow_run", { action: "completed" });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toMatch(/workflow_run/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("skips check_run actions other than 'completed'", async () => {
    const req = makeRequest("check_run", { action: "created", check_run: { head_sha: "x" } });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toMatch(/action=created/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── Payload shape validation ──────────────────────────────────────────

  it("returns 400 when head_sha is missing", async () => {
    const req = makeRequest("check_run", { action: "completed", check_run: { conclusion: "success" } });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("returns 400 on non-JSON body", async () => {
    const body = "not-json";
    const signature = crypto.createHmac("sha256", "secret").update(body).digest("hex");
    const req = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-github-event": "check_run",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(400);
  });

  // ── Happy path (publish) ──────────────────────────────────────────────

  it("publishes to Redis and returns matched=true on a valid completed event", async () => {
    const req = makeRequest("check_run", {
      action: "completed",
      check_run: {
        id: 42,
        head_sha: "abcdef1234567890",
        conclusion: "success",
      },
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.matched).toBe(true);
    expect(json.sessionId).toBe("sess-1");
    expect(json.subscribers).toBe(1);

    expect(mockPublish).toHaveBeenCalledWith(
      "abcdef1234567890",
      expect.objectContaining({
        conclusion: "success",
        deliveryId: "abc-123",
        checkRunId: 42,
      }),
    );
    expect(mockMarkIntegrationSuccess).toHaveBeenCalledWith(VALID_ID);
  });

  it("returns matched=false when no session is registered for this head_sha", async () => {
    mockPublish.mockResolvedValueOnce(null);
    const req = makeRequest("check_run", {
      action: "completed",
      check_run: {
        id: 77,
        head_sha: "nomatch0000000000",
        conclusion: "failure",
      },
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.matched).toBe(false);
  });

  it("forwards unknown conclusions verbatim (defensive — never rewrites GitHub's enum)", async () => {
    const req = makeRequest("check_run", {
      action: "completed",
      check_run: { id: 1, head_sha: "abcdef1234567890", conclusion: "stale" },
    });
    await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(mockPublish).toHaveBeenCalledWith(
      "abcdef1234567890",
      expect.objectContaining({ conclusion: "stale" }),
    );
  });

  it("coerces a missing conclusion to 'unknown' to prevent downstream crashes", async () => {
    const req = makeRequest("check_run", {
      action: "completed",
      check_run: { id: 1, head_sha: "abcdef1234567890" },
    });
    await POST(req, { params: Promise.resolve({ integrationId: VALID_ID }) });
    expect(mockPublish).toHaveBeenCalledWith(
      "abcdef1234567890",
      expect.objectContaining({ conclusion: "unknown" }),
    );
  });
});
