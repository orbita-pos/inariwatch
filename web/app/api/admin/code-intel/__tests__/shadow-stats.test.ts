/**
 * Code Intelligence v2 — Phase 1.7
 * /api/admin/code-intel/shadow-stats endpoint tests. Mirrors the
 * baseline-stats.test.ts pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionMock, executeMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: () => sessionMock(),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({
  db: { execute: executeMock },
}));

import { GET } from "@/app/api/admin/code-intel/shadow-stats/route";

const ADMIN_EMAIL = "admin@inariwatch.com";

beforeEach(() => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  sessionMock.mockReset();
  executeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/code-intel/shadow-stats", () => {
  it("rejects non-admin sessions", async () => {
    sessionMock.mockResolvedValue({ user: { email: "rando@example.com" } });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated callers", async () => {
    sessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns aggregated shadow payload for admin", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    // First call: summary row.
    executeMock.mockResolvedValueOnce([
      {
        total_calls: 100,
        v1_p50_ms: 30,
        v1_p95_ms: 90,
        v2_p50_ms: 20,
        v2_p95_ms: 60,
        v1_errors: 2,
        v2_errors: 5,
        divergent_calls: 12,
        empty_v2_calls: 3,
      },
    ]);
    // Second call: top diverging.
    executeMock.mockResolvedValueOnce([
      {
        query: "auth",
        v1_top: ["src/auth/login.ts::login"],
        v2_top: ["src/auth/login.ts::validateUser"],
        created_at: new Date("2026-05-02T10:00:00Z"),
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCalls).toBe(100);
    expect(body.v1.p50Ms).toBe(30);
    expect(body.v2.p95Ms).toBe(60);
    expect(body.divergence.count).toBe(12);
    expect(body.divergence.pct).toBe(12);
    expect(body.topDiverging.length).toBe(1);
    expect(body.topDiverging[0].query).toBe("auth");
    expect(body.windowHours).toBe(24);
  });

  it("handles empty result set with zero divergence pct", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCalls).toBe(0);
    expect(body.divergence.pct).toBe(0);
    expect(body.topDiverging).toEqual([]);
  });

  it("supports the {rows: [...]} shape (neon-http driver)", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          total_calls: 5,
          v1_p50_ms: 10,
          v1_p95_ms: 30,
          v2_p50_ms: 5,
          v2_p95_ms: 15,
          v1_errors: 0,
          v2_errors: 0,
          divergent_calls: 0,
          empty_v2_calls: 0,
        },
      ],
    });
    executeMock.mockResolvedValueOnce({ rows: [] });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCalls).toBe(5);
  });
});
