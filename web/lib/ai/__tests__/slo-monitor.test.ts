import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// `slo-monitor` only uses `db.execute()` (raw SQL for PERCENTILE_CONT +
// UPSERT) and `db.select().from().where().orderBy()` (for the widget
// helpers). We mock both. The select chain records each stage so tests
// can assert the correct table + predicates landed.

const executeMock = vi.fn();

const selectChain = {
  from: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
};

vi.mock("@/lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => executeMock(...args),
    select: () => ({
      from: (t: unknown) => {
        selectChain.from(t);
        return {
          where: (w: unknown) => {
            selectChain.where(w);
            return {
              orderBy: (o: unknown) => {
                selectChain.orderBy(o);
                return Promise.resolve(selectResult);
              },
            };
          },
        };
      },
    }),
  },
  sloEvents: {
    resolvedAt: Symbol("sloEvents.resolvedAt"),
    lastBreachAt: Symbol("sloEvents.lastBreachAt"),
    createdAt: Symbol("sloEvents.createdAt"),
  },
  remediationSessions: Symbol("remediationSessions"),
}));

// rows container used by widget helper tests
let selectResult: unknown[] = [];

// Import AFTER mocks
import {
  measureTiers,
  detectBreaches,
  recordBreaches,
  runSLOCheck,
  getActiveBreaches,
  getRecentHistory,
  SLO_DEFINITIONS,
  WINDOW_MINUTES,
  PAGING_THRESHOLD,
  type Tier,
  type TierMeasurement,
} from "../slo-monitor";

const rowsResult = <T>(rows: T[]) => ({ rows } as unknown as { rows: T[] });

beforeEach(() => {
  executeMock.mockReset();
  selectChain.from.mockReset();
  selectChain.where.mockReset();
  selectChain.orderBy.mockReset();
  selectResult = [];
});

// ── SLO_DEFINITIONS sanity ──────────────────────────────────────────────────

describe("SLO_DEFINITIONS", () => {
  it("defines all 4 tiers with sensible thresholds", () => {
    for (const tier of ["0", "1", "2", "3"] as Tier[]) {
      const slo = SLO_DEFINITIONS[tier];
      expect(slo.p95LatencyMs).toBeGreaterThan(0);
      expect(slo.successRate).toBeGreaterThan(0);
      expect(slo.successRate).toBeLessThanOrEqual(1);
      expect(slo.minSamples).toBeGreaterThanOrEqual(1);
    }
  });

  it("has ascending p95 thresholds across tiers (deeper tiers are allowed more time)", () => {
    expect(SLO_DEFINITIONS["0"].p95LatencyMs).toBeLessThan(SLO_DEFINITIONS["1"].p95LatencyMs);
    expect(SLO_DEFINITIONS["1"].p95LatencyMs).toBeLessThan(SLO_DEFINITIONS["2"].p95LatencyMs);
    expect(SLO_DEFINITIONS["2"].p95LatencyMs).toBeLessThan(SLO_DEFINITIONS["3"].p95LatencyMs);
  });
});

// ── measureTiers ────────────────────────────────────────────────────────────

describe("measureTiers", () => {
  it("returns a row per tier and computes success_rate + p95", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier: "2", sample_count: "10", success_count: "9",  p95_ms: "42000" },
      { tier: "1", sample_count: "5",  success_count: "4",  p95_ms: "15000" },
    ]));

    const out = await measureTiers();
    expect(out).toHaveLength(4);
    const byTier = new Map<Tier, TierMeasurement>(out.map((m) => [m.tier, m]));

    const t1 = byTier.get("1")!;
    expect(t1.sampleCount).toBe(5);
    expect(t1.successCount).toBe(4);
    expect(t1.successRate).toBeCloseTo(0.8, 5);
    expect(t1.p95LatencyMs).toBe(15000);

    const t2 = byTier.get("2")!;
    expect(t2.sampleCount).toBe(10);
    expect(t2.successRate).toBeCloseTo(0.9, 5);
    expect(t2.p95LatencyMs).toBe(42000);
  });

  it("returns nulls when a tier is below its minSamples threshold", async () => {
    // Tier 0 has minSamples=5. Only 2 sessions in the window → nulls.
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier: "0", sample_count: "2", success_count: "2", p95_ms: "400" },
    ]));
    const out = await measureTiers();
    const t0 = out.find((m) => m.tier === "0")!;
    expect(t0.sampleCount).toBe(2);
    expect(t0.successRate).toBeNull();
    expect(t0.p95LatencyMs).toBeNull();
  });

  it("fills empty tiers with zero samples + nulls when no rows returned", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([]));
    const out = await measureTiers();
    for (const m of out) {
      expect(m.sampleCount).toBe(0);
      expect(m.successRate).toBeNull();
      expect(m.p95LatencyMs).toBeNull();
    }
  });

  it("skips rows with unknown tier values (future-proofing)", async () => {
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier: "legacy", sample_count: "10", success_count: "9", p95_ms: "30000" },
    ]));
    const out = await measureTiers();
    for (const m of out) expect(m.sampleCount).toBe(0);
  });
});

// ── detectBreaches ──────────────────────────────────────────────────────────

describe("detectBreaches", () => {
  it("flags a breach when success_rate is below threshold", () => {
    const m: TierMeasurement = {
      tier: "1", sampleCount: 20, successCount: 15, successRate: 0.75, p95LatencyMs: 10_000,
    };
    const { breaches, okPairs } = detectBreaches([m]);
    const rateBreach = breaches.find((b) => b.metric === "success_rate");
    expect(rateBreach).toBeDefined();
    expect(rateBreach!.tier).toBe("1");
    expect(rateBreach!.threshold).toBe(SLO_DEFINITIONS["1"].successRate);
    expect(rateBreach!.observed).toBeCloseTo(0.75, 5);
    // p95 is fine
    expect(okPairs).toContainEqual({ tier: "1", metric: "p95_latency_ms" });
  });

  it("flags a breach when p95 is above threshold", () => {
    const m: TierMeasurement = {
      tier: "2", sampleCount: 10, successCount: 10, successRate: 1.0, p95LatencyMs: 200_000,
    };
    const { breaches, okPairs } = detectBreaches([m]);
    expect(breaches.find((b) => b.metric === "p95_latency_ms")).toBeDefined();
    expect(okPairs).toContainEqual({ tier: "2", metric: "success_rate" });
  });

  it("treats null measurements as neither breach nor ok", () => {
    const m: TierMeasurement = {
      tier: "0", sampleCount: 1, successCount: 1, successRate: null, p95LatencyMs: null,
    };
    const { breaches, okPairs } = detectBreaches([m]);
    expect(breaches).toHaveLength(0);
    expect(okPairs).toHaveLength(0);
  });

  it("reports both breaches when p95 AND success_rate breach at once", () => {
    const slo = SLO_DEFINITIONS["3"];
    const m: TierMeasurement = {
      tier: "3",
      sampleCount: 5,
      successCount: 2,
      successRate: 0.4,
      p95LatencyMs: slo.p95LatencyMs + 10_000,
    };
    const { breaches } = detectBreaches([m]);
    expect(breaches).toHaveLength(2);
  });
});

// ── recordBreaches ──────────────────────────────────────────────────────────

describe("recordBreaches", () => {
  it("upserts one row per breach and returns the event ids", async () => {
    executeMock
      .mockResolvedValueOnce(rowsResult([{ id: "evt-1" }]))
      .mockResolvedValueOnce(rowsResult([{ id: "evt-2" }]));

    const out = await recordBreaches(
      [
        { tier: "1", metric: "success_rate",   threshold: 0.85, observed: 0.7,  sampleCount: 10 },
        { tier: "2", metric: "p95_latency_ms", threshold: 90_000, observed: 120_000, sampleCount: 8 },
      ],
      []
    );

    expect(out.openedOrUpdated).toEqual(["evt-1", "evt-2"]);
    expect(out.resolved).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("stamps resolved_at on ok pairs and returns resolved ids", async () => {
    // UPDATE ... RETURNING returns the closed rows.
    executeMock.mockResolvedValueOnce(rowsResult([
      { id: "closed-1", tier: "1", metric: "success_rate" },
      { id: "closed-2", tier: "2", metric: "p95_latency_ms" },
    ]));

    const out = await recordBreaches(
      [],
      [
        { tier: "1", metric: "success_rate" },
        { tier: "2", metric: "p95_latency_ms" },
      ]
    );

    expect(out.resolved).toEqual(["closed-1", "closed-2"]);
    expect(out.openedOrUpdated).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("runs both upsert and close queries when both sets are non-empty", async () => {
    executeMock
      .mockResolvedValueOnce(rowsResult([{ id: "evt-open" }]))
      .mockResolvedValueOnce(rowsResult([{ id: "evt-close", tier: "2", metric: "p95_latency_ms" }]));

    const out = await recordBreaches(
      [{ tier: "1", metric: "success_rate", threshold: 0.85, observed: 0.7, sampleCount: 10 }],
      [{ tier: "2", metric: "p95_latency_ms" }]
    );

    expect(out.openedOrUpdated).toEqual(["evt-open"]);
    expect(out.resolved).toEqual(["evt-close"]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("no-ops when both inputs are empty", async () => {
    const out = await recordBreaches([], []);
    expect(out.openedOrUpdated).toEqual([]);
    expect(out.resolved).toEqual([]);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

// ── runSLOCheck end-to-end ──────────────────────────────────────────────────

describe("runSLOCheck", () => {
  it("glues measure → detect → record and reports counts", async () => {
    // measureTiers query — Tier 2 breaching on p95, healthy on success_rate
    executeMock.mockResolvedValueOnce(rowsResult([
      { tier: "2", sample_count: "10", success_count: "10", p95_ms: "120000" },
    ]));
    // recordBreaches upsert — breach on (tier=2, metric=p95_latency_ms)
    executeMock.mockResolvedValueOnce(rowsResult([{ id: "evt-open" }]));
    // recordBreaches close — ok on (tier=2, metric=success_rate)
    executeMock.mockResolvedValueOnce(rowsResult([]));

    const report = await runSLOCheck();

    expect(report.windowMinutes).toBe(WINDOW_MINUTES);
    expect(report.measurements).toHaveLength(4);
    expect(report.breaches).toHaveLength(1);
    expect(report.breaches[0].metric).toBe("p95_latency_ms");
    expect(report.openedOrUpdated).toEqual(["evt-open"]);
  });
});

// ── Read helpers ────────────────────────────────────────────────────────────

describe("widget read helpers", () => {
  it("getActiveBreaches filters resolved_at IS NULL and orders by last_breach_at", async () => {
    selectResult = [{ id: "b1", tier: "1", metric: "success_rate" }];
    const out = await getActiveBreaches();
    expect(out).toEqual(selectResult);
    expect(selectChain.from).toHaveBeenCalledTimes(1);
    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
  });

  it("getRecentHistory applies the hoursBack window", async () => {
    selectResult = [{ id: "h1" }];
    const out = await getRecentHistory(6);
    expect(out).toEqual(selectResult);
    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe("constants", () => {
  it("exposes WINDOW_MINUTES + PAGING_THRESHOLD for widgets to read", () => {
    expect(WINDOW_MINUTES).toBeGreaterThanOrEqual(5);
    expect(PAGING_THRESHOLD).toBeGreaterThanOrEqual(2);
  });
});
