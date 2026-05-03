/**
 * Code Intelligence v2 — Phase 0.3
 * /api/admin/code-intel/baseline-stats endpoint tests. Same shape as
 * summary.test.ts so the v2 work fits next to the existing widget tests.
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

import { GET } from "@/app/api/admin/code-intel/baseline-stats/route";

const ADMIN_EMAIL = "admin@inariwatch.com";

beforeEach(() => {
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  sessionMock.mockReset();
  executeMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/admin/code-intel/baseline-stats", () => {
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

  it("returns aggregated baseline payload for admin", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock
      // chunk totals
      .mockResolvedValueOnce({
        rows: [
          {
            total_chunks: 1000,
            with_embedding: 800,
            by_voyage: 700,
            by_openai: 100,
          },
        ],
      })
      // repo totals
      .mockResolvedValueOnce({
        rows: [{ total: 5, ready: 4, indexing: 1, failed: 0 }],
      })
      // dependency ambiguity
      .mockResolvedValueOnce({
        rows: [{ total_edges: 200, homonym_poisoned_edges: 60 }],
      })
      // languages
      .mockResolvedValueOnce({
        rows: [
          { language: "typescript", count: 600 },
          { language: "python", count: 400 },
        ],
      });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.repos).toEqual({ total: 5, ready: 4, indexing: 1, failed: 0 });
    expect(body.chunks.total).toBe(1000);
    expect(body.chunks.withEmbedding).toBe(800);
    expect(body.chunks.embeddingCoveragePct).toBe(80);
    expect(body.chunks.byModel["voyage-code-3"]).toBe(700);
    expect(body.chunks.byModel["openai-text-embedding-3-small"]).toBe(100);
    expect(body.dependencies.totalEdges).toBe(200);
    expect(body.dependencies.homonymPoisonedEdges).toBe(60);
    expect(body.dependencies.poisonedPct).toBe(30);
    expect(body.languages).toHaveLength(2);
    expect(body.languages[0].language).toBe("typescript");
  });

  it("returns zeroed payload when tables are empty", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock
      .mockResolvedValueOnce({
        rows: [{ total_chunks: 0, with_embedding: 0, by_voyage: 0, by_openai: 0 }],
      })
      .mockResolvedValueOnce({ rows: [{ total: 0, ready: 0, indexing: 0, failed: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total_edges: 0, homonym_poisoned_edges: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await GET();
    const body = await res.json();
    expect(body.chunks.total).toBe(0);
    expect(body.chunks.embeddingCoveragePct).toBe(0);
    expect(body.dependencies.poisonedPct).toBe(0);
    expect(body.languages).toEqual([]);
  });

  it("handles array-shape rows (driver variant)", async () => {
    sessionMock.mockResolvedValue({ user: { email: ADMIN_EMAIL } });
    executeMock
      .mockResolvedValueOnce([
        { total_chunks: 10, with_embedding: 5, by_voyage: 5, by_openai: 0 },
      ])
      .mockResolvedValueOnce([{ total: 1, ready: 1, indexing: 0, failed: 0 }])
      .mockResolvedValueOnce([{ total_edges: 4, homonym_poisoned_edges: 1 }])
      .mockResolvedValueOnce([{ language: "typescript", count: 10 }]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chunks.total).toBe(10);
    expect(body.chunks.embeddingCoveragePct).toBe(50);
    expect(body.dependencies.poisonedPct).toBe(25);
  });
});
