/**
 * Unit tests for env-distribution.service.ts pure functions.
 *
 * Tests aggregate(), analyzeCoverage(), and parseNodeMajor() without
 * touching the DB — covers malformed payloads, edge cases around the
 * coverage thresholds, skip reasons, and sort order.
 */

import { describe, it, expect } from "vitest";
import {
  aggregate,
  analyzeCoverage,
  parseNodeMajor,
} from "../env-distribution.service";

// ── parseNodeMajor ────────────────────────────────────────────────────────

describe("parseNodeMajor", () => {
  it("parses SDK-native 'v20.11.1'", () => {
    expect(parseNodeMajor("v20.11.1")).toBe(20);
  });

  it("parses plain '18.19.0'", () => {
    expect(parseNodeMajor("18.19.0")).toBe(18);
  });

  it("parses 'node-v22'", () => {
    expect(parseNodeMajor("node-v22")).toBe(22);
  });

  it("parses integer-only '22'", () => {
    expect(parseNodeMajor("22")).toBe(22);
  });

  it("returns null for null input", () => {
    expect(parseNodeMajor(null)).toBeNull();
  });

  it("returns null for garbage string", () => {
    expect(parseNodeMajor("latest")).toBeNull();
  });

  it("rejects absurd majors (>= 1000)", () => {
    expect(parseNodeMajor("v1000.0.0")).toBeNull();
  });
});

// ── aggregate ─────────────────────────────────────────────────────────────

describe("aggregate", () => {
  it("returns empty distribution when no payloads", () => {
    const d = aggregate([]);
    expect(d.totalSessions).toBe(0);
    expect(d.distribution).toEqual({});
    expect(d.vectors).toEqual([]);
  });

  it("skips null / non-object payloads silently", () => {
    const d = aggregate([null, undefined, 42, "string", { notEnv: true }]);
    expect(d.totalSessions).toBe(0);
  });

  it("skips payloads without env key", () => {
    const d = aggregate([{ git: { commit: "abc" } }, { user: { id: "x" } }]);
    expect(d.totalSessions).toBe(0);
  });

  it("groups by node major", () => {
    const payloads = [
      { env: { node: "v20.11.1", platform: "linux", arch: "x64" } },
      { env: { node: "v20.5.0", platform: "linux", arch: "x64" } },
      { env: { node: "v18.19.0", platform: "linux", arch: "x64" } },
      { env: { node: "v22.0.0", platform: "darwin", arch: "arm64" } },
    ];
    const d = aggregate(payloads);
    expect(d.totalSessions).toBe(4);
    expect(d.distribution["node@20"]!.sessionCount).toBe(2);
    expect(d.distribution["node@18"]!.sessionCount).toBe(1);
    expect(d.distribution["node@22"]!.sessionCount).toBe(1);
    expect(d.distribution["node@20"]!.trafficPercent).toBe(50);
    expect(d.distribution["node@18"]!.trafficPercent).toBe(25);
  });

  it("accepts node_version as alternate key", () => {
    const payloads = [
      { env: { node_version: "18.0.0", platform: "linux", arch: "x64" } },
    ];
    const d = aggregate(payloads);
    expect(d.distribution["node@18"]!.sessionCount).toBe(1);
  });

  it("buckets unparseable node versions under node@unknown", () => {
    const payloads = [
      { env: { node: "latest", platform: "linux" } },
      { env: { platform: "linux" } }, // no node field at all
    ];
    const d = aggregate(payloads);
    expect(d.totalSessions).toBe(2);
    expect(d.distribution["node@unknown"]!.sessionCount).toBe(2);
  });

  it("returns vectors sorted by sessionCount descending", () => {
    const payloads = [
      { env: { node: "v18.0.0" } },
      { env: { node: "v20.0.0" } },
      { env: { node: "v20.1.0" } },
      { env: { node: "v20.2.0" } },
      { env: { node: "v22.0.0" } },
      { env: { node: "v22.1.0" } },
    ];
    const d = aggregate(payloads);
    expect(d.vectors[0]!.sessionCount).toBe(3); // node@20
    expect(d.vectors[1]!.sessionCount).toBe(2); // node@22
    expect(d.vectors[2]!.sessionCount).toBe(1); // node@18
  });

  it("preserves platform + arch + appVersion in vectors", () => {
    const payloads = [
      { env: { node: "v20.0.0", platform: "linux", arch: "x64", app_version: "3.2.1" } },
    ];
    const d = aggregate(payloads);
    expect(d.vectors[0]!.platform).toBe("linux");
    expect(d.vectors[0]!.arch).toBe("x64");
    expect(d.vectors[0]!.appVersion).toBe("3.2.1");
  });

  it("trafficPercent sums to 100 within rounding tolerance", () => {
    const payloads = [
      { env: { node: "v18.0.0" } },
      { env: { node: "v20.0.0" } },
      { env: { node: "v22.0.0" } },
    ];
    const d = aggregate(payloads);
    const total = Object.values(d.distribution).reduce((s, e) => s + e.trafficPercent, 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.5);
  });
});

// ── analyzeCoverage ───────────────────────────────────────────────────────

const thresholds = { highPercent: 20, mediumPercent: 10 };

function dist(entries: Record<string, { count: number; pct: number }>) {
  const distribution: Record<string, { sessionCount: number; trafficPercent: number }> = {};
  let total = 0;
  for (const [key, { count, pct }] of Object.entries(entries)) {
    distribution[key] = { sessionCount: count, trafficPercent: pct };
    total += count;
  }
  return { distribution, vectors: [], totalSessions: total };
}

describe("analyzeCoverage", () => {
  it("skips when project distribution is empty", () => {
    const project = dist({});
    const fleet = dist({ "node@20": { count: 5, pct: 100 } });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.applicable).toBe(false);
    expect(r.skipReason).toBe("no-project-data");
  });

  it("skips when project has only one env (no diversity)", () => {
    const project = dist({ "node@20": { count: 100, pct: 100 } });
    const fleet = dist({ "node@20": { count: 5, pct: 100 } });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.applicable).toBe(false);
    expect(r.skipReason).toBe("single-env");
  });

  it("skips when fleet distribution is empty but project is multi-env", () => {
    const project = dist({
      "node@18": { count: 40, pct: 40 },
      "node@20": { count: 60, pct: 60 },
    });
    const fleet = dist({});
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.applicable).toBe(false);
    expect(r.skipReason).toBe("no-fleet-data");
  });

  it("full coverage when fleet spans every project env", () => {
    const project = dist({
      "node@18": { count: 40, pct: 40 },
      "node@20": { count: 60, pct: 60 },
    });
    const fleet = dist({
      "node@18": { count: 2, pct: 40 },
      "node@20": { count: 3, pct: 60 },
    });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.applicable).toBe(true);
    expect(r.coveragePercent).toBe(100);
    expect(r.missingEnvsHigh).toEqual([]);
    expect(r.missingEnvsMedium).toEqual([]);
  });

  it("flags HIGH when missing env is above threshold_high_percent", () => {
    const project = dist({
      "node@18": { count: 35, pct: 35 }, // missing, >= 20% → HIGH
      "node@20": { count: 65, pct: 65 },
    });
    const fleet = dist({ "node@20": { count: 5, pct: 100 } });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.applicable).toBe(true);
    expect(r.coveragePercent).toBe(65);
    expect(r.missingEnvsHigh).toEqual(["node@18"]);
    expect(r.missingEnvsMedium).toEqual([]);
  });

  it("flags MEDIUM when missing env is between thresholds", () => {
    const project = dist({
      "node@18": { count: 15, pct: 15 }, // missing, 10-20% → MEDIUM
      "node@20": { count: 85, pct: 85 },
    });
    const fleet = dist({ "node@20": { count: 5, pct: 100 } });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.missingEnvsHigh).toEqual([]);
    expect(r.missingEnvsMedium).toEqual(["node@18"]);
    expect(r.coveragePercent).toBe(85);
  });

  it("drops LOW misses below medium threshold (below 10%)", () => {
    const project = dist({
      "node@16": { count: 3, pct: 3 }, // missing, <10% → dropped
      "node@18": { count: 47, pct: 47 },
      "node@20": { count: 50, pct: 50 },
    });
    const fleet = dist({
      "node@18": { count: 3, pct: 50 },
      "node@20": { count: 3, pct: 50 },
    });
    const r = analyzeCoverage(project, fleet, thresholds);
    expect(r.missingEnvsHigh).toEqual([]);
    expect(r.missingEnvsMedium).toEqual([]);
    expect(r.coveragePercent).toBe(97); // 47 + 50
  });

  it("sorts missing envs by traffic percent descending", () => {
    const project = dist({
      "node@16": { count: 25, pct: 25 },
      "node@18": { count: 30, pct: 30 },
      "node@22": { count: 45, pct: 45 },
    });
    const fleet = dist({}); // ALL missing, but this skips since fleet empty
    // So instead, partial fleet:
    const fleetPartial = dist({ "node@20": { count: 1, pct: 100 } });
    const r = analyzeCoverage(project, fleetPartial, thresholds);
    expect(r.missingEnvsHigh).toEqual(["node@22", "node@18", "node@16"]);
  });

  it("respects custom thresholds", () => {
    const project = dist({
      "node@18": { count: 12, pct: 12 },
      "node@20": { count: 88, pct: 88 },
    });
    const fleet = dist({ "node@20": { count: 5, pct: 100 } });
    // Custom: HIGH = 50%, MEDIUM = 5% → node@18 at 12% becomes MEDIUM
    const r = analyzeCoverage(project, fleet, { highPercent: 50, mediumPercent: 5 });
    expect(r.missingEnvsHigh).toEqual([]);
    expect(r.missingEnvsMedium).toEqual(["node@18"]);
  });
});
