/**
 * Code Intelligence v2 — Phase 3.3
 * /api/admin/code-intel/cutover-status endpoint tests.
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
  codeIntelRemediationAb: {},
  codeIntelShadowLog: {},
}));

import { GET } from "@/app/api/admin/code-intel/cutover-status/route";

const ADMIN_EMAIL = "admin@inariwatch.com";

beforeEach(() => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  sessionMock.mockReset();
  executeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function abRows(rows: Array<{ engine: string; turn_count: number; success: boolean }>) {
  return { rows };
}
function shadowRows(rows: Array<{ divergent: boolean; v2_timed_out: boolean }>) {
  return { rows };
}
function repeat<T>(item: T, n: number): T[] {
  return Array.from({ length: n }, () => item);
}

describe("GET /api/admin/code-intel/cutover-status — auth", () => {
  it("rejects unauthenticated callers", async () => {
    sessionMock.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("rejects non-admin sessions", async () => {
    sessionMock.mockResolvedValue({ user: { email: "rando@example.com" } });
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("GET /api/admin/code-intel/cutover-status — empty population", () => {
  it("returns WAIT recommendation when no samples exist (smoke test posture)", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock.mockResolvedValueOnce(abRows([])).mockResolvedValueOnce(shadowRows([]));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.recommendation).toBe("WAIT");
    expect(body.metrics.ab.total).toBe(0);
    expect(body.metrics.shadow.total).toBe(0);
  });
});

describe("GET /api/admin/code-intel/cutover-status — populated", () => {
  it("aggregates A/B + shadow rows into metrics shape; GO when all gates pass", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    const ab = [
      ...repeat({ engine: "v1", turn_count: 22, success: true }, 80),
      ...repeat({ engine: "v1", turn_count: 22, success: false }, 20),
      ...repeat({ engine: "v2", turn_count: 6, success: true }, 82),
      ...repeat({ engine: "v2", turn_count: 6, success: false }, 18),
    ];
    const shadow = [
      ...repeat({ divergent: false, v2_timed_out: false }, 90),
      ...repeat({ divergent: true, v2_timed_out: false }, 10),
    ];
    executeMock.mockResolvedValueOnce(abRows(ab)).mockResolvedValueOnce(shadowRows(shadow));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBeGreaterThan(0);
    expect(body.thresholds.minSamples).toBe(100);
    expect(body.thresholds.turnReductionPct).toBe(30);
    expect(body.thresholds.divergenceMaxPct).toBe(25);
    expect(body.metrics.ab.total).toBe(200);
    expect(body.metrics.ab.v1AvgTurns).toBe(22);
    expect(body.metrics.ab.v2AvgTurns).toBe(6);
    expect(body.metrics.ab.successDeltaPct).toBe(2);
    expect(body.metrics.shadow.divergencePct).toBe(10);
    expect(body.decision.recommendation).toBe("GO");
    expect(body.decision.gates.length).toBe(4);
  });

  it("returns ABORT when v2 success rate falls more than parity threshold below v1", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    const ab = [
      ...repeat({ engine: "v1", turn_count: 22, success: true }, 80),
      ...repeat({ engine: "v1", turn_count: 22, success: false }, 20),
      ...repeat({ engine: "v2", turn_count: 6, success: true }, 60),
      ...repeat({ engine: "v2", turn_count: 6, success: false }, 40),
    ];
    executeMock.mockResolvedValueOnce(abRows(ab)).mockResolvedValueOnce(shadowRows([]));
    const res = await GET();
    const body = await res.json();
    expect(body.decision.recommendation).toBe("ABORT");
    expect(body.decision.reasons.some((r: string) => /success/.test(r))).toBe(true);
  });

  it("returns WAIT when shadow divergence exceeds threshold", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    const ab = [
      ...repeat({ engine: "v1", turn_count: 22, success: true }, 80),
      ...repeat({ engine: "v1", turn_count: 22, success: false }, 20),
      ...repeat({ engine: "v2", turn_count: 6, success: true }, 82),
      ...repeat({ engine: "v2", turn_count: 6, success: false }, 18),
    ];
    const shadow = [
      ...repeat({ divergent: true, v2_timed_out: false }, 50),
      ...repeat({ divergent: false, v2_timed_out: false }, 50),
    ];
    executeMock.mockResolvedValueOnce(abRows(ab)).mockResolvedValueOnce(shadowRows(shadow));
    const res = await GET();
    const body = await res.json();
    expect(body.decision.recommendation).toBe("WAIT");
    expect(body.decision.reasons.some((r: string) => /divergence/.test(r))).toBe(true);
  });
});

describe("GET /api/admin/code-intel/cutover-status — driver shape + failure", () => {
  it("tolerates bare arrays from non-neon drivers", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.ab.total).toBe(0);
    expect(body.decision.recommendation).toBe("WAIT");
  });

  it("returns 500 with detail when the DB fetch throws", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock.mockRejectedValueOnce(new Error("Neon timeout"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("fetch_failed");
    expect(body.detail).toMatch(/Neon/);
  });
});
