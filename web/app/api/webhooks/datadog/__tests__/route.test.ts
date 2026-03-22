import { describe, it, expect, vi, beforeEach } from "vitest";

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
const mockCreateAlertIfNew = vi.fn().mockResolvedValue({ id: "alert-1" });
const mockMarkIntegrationSuccess = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/webhooks/shared", () => ({
  loadIntegration: (...args: unknown[]) => mockLoadIntegration(...args),
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(payload: unknown, headers = {}) {
  return new Request("https://demo.com", {
    method: "POST",
    headers: {
      "x-forwarded-for": "127.0.0.1",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();

  mockLoadIntegration.mockResolvedValue({
    id: "integ-1",
    service: "datadog",
    projectId: "proj-1",
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Datadog Webhook POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Datadog Webhook POST (/api/webhooks/datadog/[id])", () => {
  
  // ── Authentication & Infrastructure ────────────────────────────────────

  it("returns 429 if rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 30 });
    const req = makeRequest({});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(429);
  });

  it("returns 404 if integration not found", async () => {
    mockLoadIntegration.mockResolvedValueOnce(null);
    const req = makeRequest({});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 if wrong integration type", async () => {
    mockLoadIntegration.mockResolvedValueOnce({ service: "github" });
    const req = makeRequest({});
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    expect(res.status).toBe(400);
  });

  // ── Events: Datadog Monitors ──────────────────────────────────────────

  it("creates critical alert for Datadog 'error' or 'Alert' status", async () => {
    const payload = {
      title: "High CPU Usage",
      alert_type: "error",
      body: "CPU is at 99%",
      hostname: "web-worker-01",
      tags: "env:prod, service:web",
    };
    
    const req = makeRequest(payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        title: "[Datadog] High CPU Usage",
        body: expect.stringContaining("CPU is at 99%"),
        sourceIntegrations: ["datadog"],
      }),
      "proj-1"
    );
    expect(mockAutoAnalyzeAlert).toHaveBeenCalled();
    expect(mockMarkIntegrationSuccess).toHaveBeenCalledWith("integ-1");
  });

  it("creates warning alert for Datadog 'warning' status", async () => {
    const payload = {
      alert_title: "Disk Space Low",
      alert_transition: "Warn", // another variant Datadog sends
      event_msg: "Disk is at 85%",
    };
    
    const req = makeRequest(payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    expect(mockCreateAlertIfNew).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        title: "[Datadog] Disk Space Low",
        body: expect.stringContaining("Disk is at 85%"),
      }),
      "proj-1"
    );
  });

  it("skips and returns 200 for 'Recovered' or 'OK' transitions", async () => {
    const payload = {
      title: "High CPU Usage",
      alert_status: "Recovered",
    };
    
    const req = makeRequest(payload);
    const res = await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe("recovered/ok status");
    expect(mockCreateAlertIfNew).not.toHaveBeenCalled();
  });

  it("includes all available context in the alert body", async () => {
    const payload = {
      title: "OOM Kill Data",
      alert_type: "error",
      body: "Container crashed",
      hostname: "k8s-node-1",
      tags: "cluster:main",
      link: "https://app.datadoghq.com/monitors/123",
      snapshot: "https://p.datadoghq.com/snapshot",
    };
    
    const req = makeRequest(payload);
    await POST(req, { params: Promise.resolve({ integrationId: "integ-1" }) });
    
    const createCall = mockCreateAlertIfNew.mock.calls[0][0];
    expect(createCall.body).toContain("Container crashed");
    expect(createCall.body).toContain("Host: k8s-node-1");
    expect(createCall.body).toContain("Tags: cluster:main");
    expect(createCall.body).toContain("Datadog link: https://app.datadoghq.com");
    expect(createCall.body).toContain("Snapshot: https://p.datadoghq.com");
  });
});
