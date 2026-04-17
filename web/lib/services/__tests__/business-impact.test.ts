/**
 * Tests for getBusinessImpact — the rule-based scoring heuristic that
 * powers the impact badge and (later) escalation prioritization.
 *
 * The contract is "deterministic, auditable, conservative". Every test
 * here pins a specific rule or interaction so adjusting weights stays
 * a deliberate decision (not an accidental side effect).
 */

import { describe, it, expect } from "vitest";
import { getBusinessImpact } from "../business-impact";

const baseAlert = {
  title: "",
  body: "",
  severity: "warning",
  sourceIntegrations: ["capture"],
};

describe("getBusinessImpact — pattern matching", () => {
  it("matches revenue paths (highest weight)", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "POST /api/checkout returned 500" });
    expect(r.factors[0].category).toBe("revenue");
    expect(r.score).toBeGreaterThanOrEqual(35);
  });

  it("matches /payment, /billing, /subscription as revenue too", () => {
    expect(getBusinessImpact({ ...baseAlert, title: "billing webhook failed" }).factors[0]?.category).toBe("revenue");
    expect(getBusinessImpact({ ...baseAlert, title: "subscription cancel error" }).factors[0]?.category).toBe("revenue");
  });

  it("matches auth paths", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "POST /api/login 401" });
    expect(r.factors[0].category).toBe("auth");
  });

  it("matches admin paths", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "GET /admin/users crashed" });
    expect(r.factors.find((f) => f.category === "admin")).toBeDefined();
  });

  it("matches data layer signals", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "Postgres connection pool exhausted" });
    expect(r.factors.find((f) => f.category === "data")).toBeDefined();
  });

  it("matches background jobs as low impact", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "cron job failed" });
    expect(r.factors[0].category).toBe("background");
    expect(r.score).toBeLessThan(20);
  });

  it("matches public surfaces as lowest impact", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "GET /docs 500" });
    expect(r.factors[0].category).toBe("public");
    expect(r.level).toBe("low");
  });

  it("returns empty factors and score 0 when nothing matches", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "Something unfamiliar happened" });
    expect(r.factors).toEqual([]);
    expect(r.score).toBe(0);
    expect(r.level).toBe("low");
  });
});

describe("getBusinessImpact — multi-rule and de-dup", () => {
  it("counts multiple categories — checkout + admin gets both", () => {
    const r = getBusinessImpact({
      ...baseAlert,
      title: "POST /api/checkout failed for /admin user",
    });
    const cats = r.factors.map((f) => f.category);
    expect(cats).toContain("revenue");
    expect(cats).toContain("admin");
  });

  it("DOES NOT double-count same category (checkout AND billing both = revenue, only +35 once)", () => {
    const r = getBusinessImpact({
      ...baseAlert,
      title: "checkout / billing / subscription all failing",
    });
    const revenueFactors = r.factors.filter((f) => f.category === "revenue");
    expect(revenueFactors).toHaveLength(1);
  });

  it("body and sourceIntegrations are also scanned (not just title)", () => {
    const r = getBusinessImpact({
      ...baseAlert,
      title: "Something failed",
      body: "Stack trace shows /api/checkout in path",
    });
    expect(r.factors.find((f) => f.category === "revenue")).toBeDefined();
  });
});

describe("getBusinessImpact — severity multiplier", () => {
  it("critical alerts score 1.4× the base", () => {
    const warn = getBusinessImpact({ ...baseAlert, title: "/checkout failure", severity: "warning" });
    const crit = getBusinessImpact({ ...baseAlert, title: "/checkout failure", severity: "critical" });
    expect(crit.score).toBeGreaterThan(warn.score);
    expect(crit.score).toBe(Math.round(35 * 1.4));
    expect(warn.score).toBe(35);
  });

  it("info alerts score 0.6× the base", () => {
    const info = getBusinessImpact({ ...baseAlert, title: "/checkout failure", severity: "info" });
    expect(info.score).toBe(Math.round(35 * 0.6));
  });

  it("unknown severity defaults to warning multiplier (1.0×)", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout failure", severity: "weird" });
    expect(r.score).toBe(35);
  });
});

describe("getBusinessImpact — user impact bonus", () => {
  it("0 users adds 0 bonus", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout" }, 0);
    expect(r.score).toBe(35);
  });

  it("100 users adds full +20 bonus", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout" }, 100);
    expect(r.score).toBe(35 + 20);
  });

  it("1000 users still caps at +20 (logarithmic-ish)", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout" }, 1000);
    expect(r.score).toBe(35 + 20);
  });

  it("scales linearly between 0 and 100 users", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout" }, 50);
    expect(r.score).toBe(35 + 10);
  });
});

describe("getBusinessImpact — level thresholds and capping", () => {
  it("score capped at 100 even with maximum stack", () => {
    const r = getBusinessImpact({
      ...baseAlert,
      title: "/checkout /login /admin /database /dashboard /cron /docs",
      severity: "critical",
    }, 1000);
    expect(r.score).toBe(100);
  });

  it("level: 70+ = critical", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout /login /admin", severity: "critical" }, 100);
    expect(r.level).toBe("critical");
  });

  it("level: 45-69 = high", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout", severity: "critical" });
    // 35 * 1.4 = 49 → high
    expect(r.score).toBe(49);
    expect(r.level).toBe("high");
  });

  it("level: 20-44 = medium", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/checkout" });
    // 35 → medium
    expect(r.level).toBe("medium");
  });

  it("level: <20 = low", () => {
    const r = getBusinessImpact({ ...baseAlert, title: "/docs" });
    // 3 → low
    expect(r.level).toBe("low");
  });
});

describe("getBusinessImpact — defensive shape", () => {
  it("handles null body and undefined sourceIntegrations gracefully", () => {
    const r = getBusinessImpact({
      title: "/checkout failed",
      body: null,
      sourceIntegrations: null,
      severity: null,
    });
    expect(r.score).toBeGreaterThan(0);
    expect(r.factors.length).toBeGreaterThan(0);
  });

  it("returns valid shape even on completely empty alert", () => {
    const r = getBusinessImpact({ title: "", body: "", severity: "warning", sourceIntegrations: [] });
    expect(r).toMatchObject({ score: 0, level: "low", factors: [] });
  });
});
