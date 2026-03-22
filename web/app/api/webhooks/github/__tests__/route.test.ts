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

const mockAssessPRRisk = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/ai/risk-assessment", () => ({
  assessPRRisk: (...args: unknown[]) => mockAssessPRRisk(...args),
}));

const mockDbUpdate = vi.fn().mockReturnThis();
const mockDbSet = vi.fn().mockReturnThis();
const mockDbWhere = vi.fn().mockResolvedValue([]);
vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: mockDbWhere,
      }),
    }),
  },
  alerts: { projectId: "projectId", isResolved: "isResolved", title: "title", sourceIntegrations: "sourceIntegrations" },
}));

const mockDecryptConfig = vi.fn();
vi.mock("@/lib/crypto", () => ({
  decryptConfig: (...args: unknown[]) => mockDecryptConfig(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(event: string, payload: unknown, headers = {}) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("hex");
  
  return new Request("https://demo.com", {
    method: "POST",
    headers: {
      "x-forwarded-for": "127.0.0.1",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${signature}`,
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockLoadIntegration.mockResolvedValue({
    id: "integ-1",
    service: "github",
    projectId: "proj-1",
    webhookSecret: "secret",
  });

  mockDecryptConfig.mockReturnValue({
    alertConfig: {
      failed_ci: { enabled: true },
      pr_risk_assessment: { enabled: true },
    },
    owner: "test-owner",
    token: "ghp_123",
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GitHub Webhook POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("GitHub Webhook POST (/api/webhooks/github/[id])", () => {
  
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
    mockLoadIntegration.mockResolvedValueOnce({ service: "vercel" });
    const req = makeRequest("ping", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 401 if signature is missing or invalid", async () => {
    mockVerifySignature.mockReturnValueOnce(false);
    const req = makeRequest("ping", {});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 413 if payload is too large", async () => {
    const largeBody = "x".repeat(1_000_001);
    const req = new Request("https://demo.com", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=123" },
      body: largeBody,
    });
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(413);
  });

  // ── Events: check_run ─────────────────────────────────────────────────

  it("creates critical alert for failed check_run", async () => {
    const payload = {
      action: "completed",
      check_run: {
        conclusion: "failure",
        name: "test-suite",
        head_sha: "abcdef123",
        output: { summary: "3 tests failed" }
      },
      repository: { name: "my-repo", default_branch: "main" }
    };
    
    const req = makeRequest("check_run", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        title: "CI failing on my-repo/main",
        body: "Check \"test-suite\" failure on commit abcdef1.\n\n3 tests failed",
      }),
      "proj-1"
    );
    expect(mockAutoAnalyzeAlert).toHaveBeenCalled();
    expect(mockMarkIntegrationSuccess).toHaveBeenCalledWith("integ-1");
  });

  it("skips check_run if failed_ci alert is disabled in config", async () => {
    mockDecryptConfig.mockReturnValueOnce({
      alertConfig: { failed_ci: { enabled: false } },
    });
    const payload = { action: "completed", check_run: { conclusion: "failure" } };
    
    const req = makeRequest("check_run", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("failed_ci disabled");
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });

  it("auto-resolves open alerts on successful check_run", async () => {
    const payload = { action: "completed", check_run: { conclusion: "success" } };
    
    const req = makeRequest("check_run", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
    expect(mockDbWhere).toHaveBeenCalled(); // verified it ran the update
  });

  // ── Events: workflow_run ──────────────────────────────────────────────

  it("creates critical alert for failed workflow_run", async () => {
    const payload = {
      action: "completed",
      workflow_run: {
        conclusion: "failure",
        name: "Deploy Prod",
        run_number: 42,
        head_branch: "main",
        event: "push"
      },
      repository: { name: "my-repo" },
      triggering_actor: { login: "jesus" }
    };
    
    const req = makeRequest("workflow_run", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        title: "Workflow \"Deploy Prod\" failed on my-repo/main",
        body: expect.stringMatching(/Run #42 failure.\nTriggered by jesus via push./),
      }),
      "proj-1"
    );
  });

  // ── Events: pull_request ──────────────────────────────────────────────

  it("triggers PR risk assessment on pull_request opened", async () => {
    const payload = {
      action: "opened",
      pull_request: { number: 123 },
      repository: { name: "my-repo" }
    };
    
    const req = makeRequest("pull_request", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockAssessPRRisk).toHaveBeenCalledWith(
      "proj-1",
      "ghp_123",
      "test-owner",
      "my-repo",
      123
    );
  });

  it("skips PR risk assessment if disabled in config", async () => {
    mockDecryptConfig.mockReturnValueOnce({
      alertConfig: { pr_risk_assessment: { enabled: false } },
    });
    const payload = { action: "opened", pull_request: { number: 123 }, repository: { name: "my-repo" } };
    
    const req = makeRequest("pull_request", payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(mockAssessPRRisk).not.toHaveBeenCalled();
  });
});
