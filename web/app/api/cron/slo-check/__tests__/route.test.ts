/**
 * Tests for /api/cron/slo-check — Fase 12 Part A.
 *
 * Mocks runSLOCheck from lib/ai/slo-monitor and verifies auth, success
 * response shape, and error handling. The measurement logic itself is
 * covered by lib/ai/__tests__/slo-monitor.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const runSLOCheckMock = vi.fn();

vi.mock("@/lib/ai/slo-monitor", () => ({
  runSLOCheck: (...args: unknown[]) => runSLOCheckMock(...args),
}));

const ORIGINAL_ENV = { ...process.env };

function makeReq(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.authorization = authHeader;
  return new Request("http://test.local/api/cron/slo-check", { headers });
}

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("/api/cron/slo-check", () => {
  beforeEach(() => {
    vi.resetModules();
    runSLOCheckMock.mockReset();
    setEnv({ CRON_SECRET: "test-cron-secret" });
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("returns 401 when CRON_SECRET is unset", async () => {
    setEnv({ CRON_SECRET: undefined });
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer anything"));
    expect(res.status).toBe(401);
    expect(runSLOCheckMock).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Bearer token is wrong", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with counts + measurements on success", async () => {
    runSLOCheckMock.mockResolvedValueOnce({
      windowMinutes: 15,
      measurements: [
        { tier: "2", sampleCount: 10, successCount: 9, successRate: 0.9, p95LatencyMs: 42000 },
      ],
      breaches: [
        { tier: "1", metric: "success_rate", threshold: 0.85, observed: 0.7, sampleCount: 8 },
      ],
      okPairs: [{ tier: "2", metric: "success_rate" }],
      openedOrUpdated: ["evt-1"],
      resolved: [],
    });

    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.windowMinutes).toBe(15);
    expect(body.breaches).toHaveLength(1);
    expect(body.openedOrUpdated).toBe(1);
    expect(body.resolved).toBe(0);
    expect(typeof body.durationMs).toBe("number");
  });

  it("returns 500 when the check throws", async () => {
    runSLOCheckMock.mockRejectedValueOnce(new Error("db down"));
    const { GET } = await import("../route");
    const res = await GET(makeReq("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("db down");
  });
});
