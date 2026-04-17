/**
 * Tests for the per-panel `countXRows` helpers used by side-panels.tsx
 * to render tab badges. These functions are pure and don't render React,
 * so they live in a focused test file separate from any future component-
 * level smoke tests.
 *
 * The tab counts are not just cosmetic — `alert` counts drive the red
 * badge that signals "look at this tab now". A miscounted alert badge
 * means the user misses real production failures, so we lock down the
 * categorization rules.
 */

import { describe, it, expect } from "vitest";
import { countBackendRows } from "../backend-panel";
import { countAiRows } from "../ai-panel";
import type { BackendEvent, AiEvent } from "@/lib/fulltrace/manifest-aggregator";

function be(overrides: Partial<BackendEvent>): BackendEvent {
  return {
    id: overrides.id ?? "id",
    ts: overrides.ts ?? 0,
    category: overrides.category ?? "marker",
    type: overrides.type ?? "Marker",
    summary: overrides.summary ?? "",
    recordingId: overrides.recordingId ?? "rec-1",
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    ...(overrides.errorMessage !== undefined ? { errorMessage: overrides.errorMessage } : {}),
  };
}

function ai(overrides: Partial<AiEvent>): AiEvent {
  return {
    id: overrides.id ?? "id",
    ts: overrides.ts ?? 0,
    kind: overrides.kind ?? "alert",
    title: overrides.title ?? "",
    ...(overrides.body !== undefined ? { body: overrides.body } : {}),
    ...(overrides.tone !== undefined ? { tone: overrides.tone } : {}),
    ...(overrides.alertId !== undefined ? { alertId: overrides.alertId } : {}),
    ...(overrides.remediationId !== undefined ? { remediationId: overrides.remediationId } : {}),
  };
}

describe("countBackendRows", () => {
  it("returns zeros for empty input", () => {
    expect(countBackendRows([])).toEqual({
      total: 0,
      errors: 0,
      byCategory: { http: 0, db: 0, fs: 0, dns: 0, exception: 0, process: 0, time: 0, random: 0, marker: 0 },
    });
  });

  it("totals events and bins them by category", () => {
    const events = [
      be({ category: "http" }),
      be({ category: "http" }),
      be({ category: "db" }),
      be({ category: "fs" }),
    ];
    const r = countBackendRows(events);
    expect(r.total).toBe(4);
    expect(r.byCategory.http).toBe(2);
    expect(r.byCategory.db).toBe(1);
    expect(r.byCategory.fs).toBe(1);
    expect(r.byCategory.dns).toBe(0);
  });

  it("counts errors: errorMessage OR exception OR status >= 400", () => {
    const events = [
      be({ category: "http", status: 200 }),                       // ok
      be({ category: "http", status: 404 }),                       // error (4xx)
      be({ category: "http", status: 500 }),                       // error (5xx)
      be({ category: "http", errorMessage: "ECONNRESET" }),        // error (errorMessage)
      be({ category: "exception" }),                               // error (category)
      be({ category: "db", errorMessage: "deadlock" }),            // error (errorMessage on db)
    ];
    const r = countBackendRows(events);
    expect(r.errors).toBe(5);
  });

  it("does NOT count 3xx as errors (redirect, not failure)", () => {
    const events = [
      be({ category: "http", status: 301 }),
      be({ category: "http", status: 304 }),
    ];
    expect(countBackendRows(events).errors).toBe(0);
  });
});

describe("countAiRows", () => {
  it("returns zeros for empty input", () => {
    expect(countAiRows([])).toEqual({ total: 0, alerts: 0, failures: 0 });
  });

  it("counts alerts only when kind === 'alert'", () => {
    const events = [
      ai({ kind: "alert" }),
      ai({ kind: "alert" }),
      ai({ kind: "diagnosis" }),
      ai({ kind: "remediation_started" }),
    ];
    const r = countAiRows(events);
    expect(r.total).toBe(4);
    expect(r.alerts).toBe(2);
  });

  it("counts failures: remediation_failed OR fix_reverted", () => {
    const events = [
      ai({ kind: "remediation_failed" }),
      ai({ kind: "fix_reverted" }),
      ai({ kind: "remediation_completed" }),
      ai({ kind: "fix_merged" }),
    ];
    const r = countAiRows(events);
    expect(r.failures).toBe(2);
  });

  it("does not double-count alerts as failures (or vice versa)", () => {
    const events = [
      ai({ kind: "alert" }),
      ai({ kind: "remediation_failed" }),
    ];
    const r = countAiRows(events);
    expect(r.alerts).toBe(1);
    expect(r.failures).toBe(1);
    expect(r.total).toBe(2);
  });
});
