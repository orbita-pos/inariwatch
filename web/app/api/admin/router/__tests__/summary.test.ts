/**
 * v0.3 S2.5 — /api/admin/router/receipts/summary endpoint tests.
 *
 * Stubs db.execute + getServerSession and asserts admin gating + payload shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.fn();
const executeMock = vi.fn();

vi.mock("next-auth", () => ({
  getServerSession: () => sessionMock(),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({
  db: { execute: executeMock },
}));

import { GET } from "@/app/api/admin/router/receipts/summary/route";

const ADMIN_EMAIL = "admin@inariwatch.com";

beforeEach(() => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  sessionMock.mockReset();
  executeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/router/receipts/summary", () => {
  it("rejects non-admin", async () => {
    sessionMock.mockResolvedValue({ user: { email: "rando@example.com" } });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated", async () => {
    sessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns aggregated summary for admin", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock
      // substrate aggregation
      .mockResolvedValueOnce({
        rows: [
          { substrate: "cloud", count: 30, p50_duration_ms: 120, p95_duration_ms: 450 },
          { substrate: "user-sidecar", count: 5, p50_duration_ms: 80, p95_duration_ms: 300 },
        ],
      })
      // tasks aggregation
      .mockResolvedValueOnce({
        rows: [
          { task: "chat.conversational", count: 20 },
          { task: "alert.auto-analyze", count: 10 },
        ],
      })
      // totals
      .mockResolvedValueOnce({ rows: [{ total: 35, fallback_count: 2 }] });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(24);
    expect(body.total).toBe(35);
    expect(body.bySubstrate).toHaveLength(2);
    expect(body.bySubstrate[0]).toMatchObject({
      substrate: "cloud",
      count: 30,
      p50DurationMs: 120,
      p95DurationMs: 450,
    });
    expect(body.topTasks[0].task).toBe("chat.conversational");
    expect(body.fallbackCount).toBe(2);
  });

  it("handles array-shape rows (driver variant)", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock
      .mockResolvedValueOnce([
        { substrate: "cloud", count: 1, p50_duration_ms: 100, p95_duration_ms: 100 },
      ])
      .mockResolvedValueOnce([{ task: "alert.correlate", count: 1 }])
      .mockResolvedValueOnce([{ total: 1, fallback_count: 0 }]);

    const res = await GET();
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.topTasks).toHaveLength(1);
  });
});
