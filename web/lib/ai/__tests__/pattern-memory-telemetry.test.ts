import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMock = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import {
  getTierDistribution,
  getClassifierAccuracy,
  getLookupHitRate,
} from "../pattern-memory-telemetry";

const rowsResult = <T>(rows: T[]) => Object.assign([...rows], { rows });

beforeEach(() => {
  executeMock.mockReset();
});

describe("getTierDistribution", () => {
  it("returns empty list when no sessions", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    const r = await getTierDistribution();
    expect(r).toEqual([]);
  });

  it("aggregates by tier_used", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier_used: "0", count: 2 },
      { tier_used: "1", count: 5 },
      { tier_used: "2", count: 20 },
      { tier_used: "3", count: 1 },
      { tier_used: "legacy", count: 3 },
    ]));
    const r = await getTierDistribution();
    expect(r).toHaveLength(5);
    expect(r.find((x) => x.tier === "2")?.count).toBe(20);
  });

  it("ignores unexpected tier values", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier_used: "4", count: 1 },
      { tier_used: "unknown", count: 1 },
      { tier_used: "1", count: 3 },
    ]));
    const r = await getTierDistribution();
    expect(r).toHaveLength(1);
    expect(r[0].tier).toBe("1");
  });

  it("parses numeric counts from strings (pg driver sometimes returns strings)", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier_used: "2", count: "42" },
    ]));
    const r = await getTierDistribution();
    expect(r[0].count).toBe(42);
  });
});

describe("getClassifierAccuracy", () => {
  it("returns isApproximation=true always for Fase 6", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ labeled: 10, accurate: 8 }]));
    const r = await getClassifierAccuracy();
    expect(r.isApproximation).toBe(true);
  });

  it("computes percentage", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ labeled: 50, accurate: 42 }]));
    const r = await getClassifierAccuracy();
    expect(r.accuracyPct).toBe(84);
  });

  it("handles zero labeled without dividing by zero", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ labeled: 0, accurate: 0 }]));
    const r = await getClassifierAccuracy();
    expect(r.accuracyPct).toBe(0);
  });
});

describe("getLookupHitRate", () => {
  it("computes hit rate as percentage", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ total: 100, hits: 23 }]));
    const r = await getLookupHitRate();
    expect(r.hitRatePct).toBe(23);
  });

  it("returns 0% when no lookups", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ total: 0, hits: 0 }]));
    const r = await getLookupHitRate();
    expect(r.hitRatePct).toBe(0);
  });

  it("parses string counts from pg", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([{ total: "40", hits: "10" }]));
    const r = await getLookupHitRate();
    expect(r.totalLookups).toBe(40);
    expect(r.hits).toBe(10);
    expect(r.hitRatePct).toBe(25);
  });
});
