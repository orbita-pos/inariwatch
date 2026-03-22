import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/lib/db ─────────────────────────────────────────────────────────────
// Mocked at the top level so it applies before any dynamic imports below.

const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  alerts: {},
  projectIntegrations: {},
}));

// Also stub drizzle-orm helpers used by the module at import time
vi.mock("drizzle-orm", () => {
  function sqlTag(strings: TemplateStringsArray, ...vals: unknown[]) {
    return { strings, vals };
  }
  sqlTag.raw = (s: string) => s;
  return {
    inArray: (_col: unknown, vals: unknown) => vals,
    sql: sqlTag,
    and: (...args: unknown[]) => args,
    eq: (_a: unknown, _b: unknown) => true,
    gt: (_a: unknown, _b: unknown) => true,
    like: (_a: unknown, _b: unknown) => true,
  };
});

const { detectAnomalies, runAnomalyEngine } = await import("../anomaly");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a chainable select mock that resolves to `rows`. */
function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(rows),
  };
  return vi.fn().mockReturnValue(chain);
}

/** Reset all db mock implementations between tests. */
function resetDb() {
  mockExecute.mockReset();
  mockSelect.mockReset();
  mockUpdate.mockReset();

  // Default execute: return empty rows
  mockExecute.mockResolvedValue({ rows: [] });

  // Default select: return empty array
  mockSelect.mockImplementation(makeSelectChain([]));

  // Default update: no-op chainable
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

// ── detectAnomalies ───────────────────────────────────────────────────────────

describe("detectAnomalies", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetDb();
  });

  it("returns [] immediately when projectIds is empty", async () => {
    const results = await detectAnomalies([]);
    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns [] when all DB queries return empty rows", async () => {
    const results = await detectAnomalies(["proj-1"]);
    expect(results).toEqual([]);
  });

  it("detectAlertSpikes: creates a critical anomaly when recent count is ≥5× the hourly baseline", async () => {
    // baseline: avg 2/hr; recent: 12 in 2h → ratio 6× → critical
    mockExecute
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", avg_per_hour: 2 }] })  // baseline
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", recent_count: 12 }] }) // recent
      .mockResolvedValueOnce({ rows: [] }) // repeating failures
      .mockResolvedValueOnce({ rows: [] }); // silent projects

    const results = await detectAnomalies(["proj-1"]);

    const spike = results.find((r) => r.title === "Anomaly: alert surge detected");
    expect(spike).toBeDefined();
    expect(spike!.severity).toBe("critical");
    expect(spike!.projectId).toBe("proj-1");
  });

  it("detectAlertSpikes: creates a warning anomaly when recent count is 3–5× the hourly baseline", async () => {
    // baseline: avg 2/hr; recent: 8 in 2h → ratio 4× → warning
    mockExecute
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", avg_per_hour: 2 }] })
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", recent_count: 8 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const results = await detectAnomalies(["proj-1"]);

    const elevated = results.find((r) => r.title === "Anomaly: alert rate elevated");
    expect(elevated).toBeDefined();
    expect(elevated!.severity).toBe("warning");
  });

  it("detectAlertSpikes: skips projects with fewer than 3 recent alerts regardless of ratio", async () => {
    // recent_count = 2 → below the minimum of 3
    mockExecute
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", avg_per_hour: 0.1 }] })
      .mockResolvedValueOnce({ rows: [{ project_id: "proj-1", recent_count: 2 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const results = await detectAnomalies(["proj-1"]);
    expect(results.some((r) => r.title.startsWith("Anomaly: alert"))).toBe(false);
  });

  it("detectRepeatingFailures: creates a warning when an alert title repeats ≥3 times in 24h", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // baseline (spikes)
      .mockResolvedValueOnce({ rows: [] }) // recent (spikes)
      .mockResolvedValueOnce({             // repeating failures
        rows: [{ project_id: "proj-1", alert_title: "CI failing on api/main", occurrences: 4 }],
      })
      .mockResolvedValueOnce({ rows: [] }); // silent projects

    const results = await detectAnomalies(["proj-1"]);

    const repeating = results.find((r) => r.title.startsWith("Anomaly: recurring failure"));
    expect(repeating).toBeDefined();
    expect(repeating!.severity).toBe("warning");
    expect(repeating!.title).toContain("CI failing on api/main");
  });

  it("detectIntegrationErrors: creates a warning when an integration has errorCount > 5", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // baseline
      .mockResolvedValueOnce({ rows: [] }) // recent
      .mockResolvedValueOnce({ rows: [] }); // repeating failures
    // silent projects query is also execute
    // But detectIntegrationErrors uses db.select, not db.execute
    mockExecute.mockResolvedValueOnce({ rows: [] }); // silent

    mockSelect.mockImplementation(
      makeSelectChain([
        { projectId: "proj-1", service: "github", errorCount: 8, lastCheckedAt: new Date("2026-03-21T10:00:00Z") },
      ])
    );

    const results = await detectAnomalies(["proj-1"]);

    const intErr = results.find((r) => r.title.includes("github integration failing"));
    expect(intErr).toBeDefined();
    expect(intErr!.severity).toBe("warning");
  });

  it("detectSilentProjects: creates an info anomaly when avgDaily ≥ 2 but last 7d count is 0", async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [] }) // baseline (spikes)
      .mockResolvedValueOnce({ rows: [] }) // recent (spikes)
      .mockResolvedValueOnce({ rows: [] }) // repeating failures
      .mockResolvedValueOnce({             // silent projects
        rows: [{ project_id: "proj-1", avg_daily: 5, last_7d_count: 0 }],
      });

    const results = await detectAnomalies(["proj-1"]);

    const silent = results.find((r) => r.title === "Anomaly: silent project detected");
    expect(silent).toBeDefined();
    expect(silent!.severity).toBe("info");
    expect(silent!.projectId).toBe("proj-1");
  });
});

// ── runAnomalyEngine ──────────────────────────────────────────────────────────

describe("runAnomalyEngine", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetDb();
  });

  it("returns [] immediately when projectIds is empty", async () => {
    const results = await runAnomalyEngine([]);
    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns detected anomalies and calls autoResolve (select for open anomalies)", async () => {
    // All detectors return empty; no current anomalies
    // autoResolve calls db.select to find open anomaly alerts
    mockSelect.mockImplementation(makeSelectChain([]));

    const results = await runAnomalyEngine(["proj-1"]);

    expect(results).toEqual([]);
    // select was called (at least once for detectIntegrationErrors + autoResolve)
    expect(mockSelect).toHaveBeenCalled();
  });
});
