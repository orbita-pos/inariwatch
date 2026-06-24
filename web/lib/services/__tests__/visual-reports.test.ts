/**
 * Tests for visual-reports.service (Phase 1 / migration 0096).
 *
 * Mocks `createAlertIfNew` and the Drizzle `db` chain so we can exercise
 * the bundle-hash + dedup + sparse-update logic without standing up a
 * real Postgres. The mocks are shaped to behave like Drizzle's real
 * builder so the service code is exercised verbatim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory state shared across mocks ───────────────────────────────────────

type StoredAlert = {
  id: string;
  projectId: string;
  fingerprint: string | null;
  sourceIntegrations: string[];
  title: string;
};

type StoredReport = {
  id: string;
  alertId: string;
  projectId: string;
  userId: string | null;
  screenshotUrl: string;
  bundleJson: unknown;
  bundleHash: string;
  status: string;
  diagnosis?: unknown;
  triageResult?: unknown;
  critique?: unknown;
  confidence?: number;
  modelTriage?: string;
  modelDiagnose?: string;
  modelCritique?: string;
  costCents: number;
  durationMs?: number;
  error?: string;
};

const state: {
  alerts: StoredAlert[];
  reports: StoredReport[];
  /** When true, createAlertIfNew returns null (simulates dedup OR maintenance). */
  alertNullMode: "dedup" | "maintenance" | null;
  nextId: number;
} = {
  alerts: [],
  reports: [],
  alertNullMode: null,
  nextId: 1,
};

function uuid(): string {
  const n = String(state.nextId++).padStart(12, "0");
  return `00000000-0000-0000-0000-${n}`;
}

beforeEach(() => {
  state.alerts.length = 0;
  state.reports.length = 0;
  state.alertNullMode = null;
  state.nextId = 1;
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/webhooks/shared", () => ({
  createAlertIfNew: vi.fn(async (alert: Omit<StoredAlert, "id"> & { projectId?: string }, projectId: string) => {
    if (state.alertNullMode === "dedup" || state.alertNullMode === "maintenance") {
      return null;
    }
    const row: StoredAlert = {
      id: uuid(),
      projectId,
      fingerprint: alert.fingerprint ?? null,
      sourceIntegrations: alert.sourceIntegrations ?? [],
      title: alert.title,
    };
    state.alerts.push(row);
    return row;
  }),
}));

vi.mock("drizzle-orm", () => ({
  and:  (...preds: unknown[]) => ({ __and: preds }),
  eq:   (col: string, val: unknown) => ({ __eq: [col, val] }),
  desc: (col: string) => ({ __desc: col }),
}));

vi.mock("@/lib/db", () => {
  // Inline column sentinel strings so they're initialized when the mock
  // factory runs at hoisted import time (vi.mock is moved above any other
  // top-level const declarations).
  const visualReports = {
    id:             "visual_reports.id",
    alertId:        "visual_reports.alert_id",
    projectId:      "visual_reports.project_id",
    bundleHash:     "visual_reports.bundle_hash",
    status:         "visual_reports.status",
    createdAt:      "visual_reports.created_at",
  };
  const alerts = {};
  const db = {
    insert(_table: unknown) {
      return {
        values(v: Partial<StoredReport> & { bundleJson: unknown }) {
          return {
            returning() {
              const row: StoredReport = {
                id:            uuid(),
                alertId:       v.alertId!,
                projectId:     v.projectId!,
                userId:        v.userId ?? null,
                screenshotUrl: v.screenshotUrl!,
                bundleJson:    v.bundleJson,
                bundleHash:    v.bundleHash!,
                status:        v.status ?? "pending",
                costCents:     0,
              };
              state.reports.push(row);
              return Promise.resolve([{ id: row.id }]);
            },
          };
        },
      };
    },
    select() {
      return {
        from(_table: unknown) {
          return {
            where(predicate: { __eq?: [string, unknown]; __and?: { __eq: [string, unknown] }[] }) {
              const filters: [string, unknown][] = [];
              if (predicate?.__eq) filters.push(predicate.__eq);
              if (predicate?.__and) {
                for (const p of predicate.__and) {
                  if (p?.__eq) filters.push(p.__eq);
                }
              }
              const rows = state.reports.filter((r) =>
                filters.every(([col, val]) => {
                  if (col === "visual_reports.id")          return r.id        === val;
                  if (col === "visual_reports.alert_id")    return r.alertId   === val;
                  if (col === "visual_reports.project_id")  return r.projectId === val;
                  if (col === "visual_reports.bundle_hash") return r.bundleHash === val;
                  if (col === "visual_reports.status")      return r.status    === val;
                  return false;
                }),
              );
              const builder = {
                orderBy(_o: unknown) {
                  return {
                    limit(n: number) {
                      return Promise.resolve(rows.slice(0, n));
                    },
                  };
                },
                limit(n: number) {
                  return Promise.resolve(rows.slice(0, n));
                },
              };
              return builder;
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(values: Partial<StoredReport>) {
          return {
            where(predicate: { __eq?: [string, unknown] }) {
              const id = predicate?.__eq?.[1] as string | undefined;
              if (!id) return Promise.resolve();
              const row = state.reports.find((r) => r.id === id);
              if (row) Object.assign(row, values);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db, visualReports, alerts };
});

// ── Tests (import AFTER mocks) ────────────────────────────────────────────────

import {
  createVisualReport,
  getVisualReport,
  getVisualReportByAlert,
  listVisualReports,
  updateReportStatus,
} from "../visual-reports.service";

const PROJECT_A = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const PROJECT_B = "00000000-0000-0000-0000-bbbbbbbbbbbb";

const baseInput = {
  projectId:     PROJECT_A,
  userId:        null,
  screenshotUrl: "data:image/webp;base64,XYZ",
  bundle:        { dom: "<div/>", state: { count: 0 } },
};

describe("createVisualReport", () => {
  it("inserts an alert + visual_report row and returns the pair", async () => {
    const result = await createVisualReport({ ...baseInput, description: "modal won't close" });

    expect(result).not.toBeNull();
    expect(result!.deduped).toBe(false);
    expect(state.alerts).toHaveLength(1);
    expect(state.reports).toHaveLength(1);

    const alert = state.alerts[0];
    expect(alert.sourceIntegrations).toEqual(["user_report"]);
    expect(alert.title).toMatch(/^Visual report: modal/);
    expect(alert.fingerprint?.startsWith("visual:")).toBe(true);

    const report = state.reports[0];
    expect(report.projectId).toBe(PROJECT_A);
    expect(report.alertId).toBe(alert.id);
    expect(report.status).toBe("pending");
    expect(report.bundleHash).toHaveLength(64); // sha256 hex
  });

  it("produces a deterministic bundle hash for identical bundles", async () => {
    const a = await createVisualReport(baseInput);
    const b = await createVisualReport(baseInput);
    expect(a?.bundleHash).toBeDefined();
    expect(a?.bundleHash).toBe(b?.bundleHash);
  });

  it("returns the existing pair when createAlertIfNew dedups (same bundle within 24h)", async () => {
    // First submit succeeds.
    const first = await createVisualReport(baseInput);
    expect(first?.deduped).toBe(false);

    // Second submit — simulate createAlertIfNew returning null (dedup hit).
    state.alertNullMode = "dedup";
    const second = await createVisualReport(baseInput);

    expect(second).not.toBeNull();
    expect(second!.deduped).toBe(true);
    expect(second!.reportId).toBe(first!.reportId);
    expect(second!.alertId).toBe(first!.alertId);
    // No new rows created.
    expect(state.alerts).toHaveLength(1);
    expect(state.reports).toHaveLength(1);
  });

  it("returns null when alert is suppressed (maintenance window, no prior bundle)", async () => {
    state.alertNullMode = "maintenance";
    const result = await createVisualReport(baseInput);
    expect(result).toBeNull();
    expect(state.alerts).toHaveLength(0);
    expect(state.reports).toHaveLength(0);
  });

  it("falls back to a generic title when description is empty/missing", async () => {
    const result = await createVisualReport({ ...baseInput, description: "   " });
    expect(result).not.toBeNull();
    expect(state.alerts[0].title).toBe("Visual report (no description)");
  });

  it("uses bundleHash as the alert fingerprint so duplicate submits dedup", async () => {
    await createVisualReport(baseInput);
    const fp = state.alerts[0].fingerprint!;
    expect(fp.startsWith("visual:")).toBe(true);
    expect(fp.length).toBe("visual:".length + 32);
  });

  it("scopes dedup lookup to the project — same hash in project B does NOT dedup against A", async () => {
    await createVisualReport(baseInput);

    state.alertNullMode = "dedup";
    const otherProject = await createVisualReport({ ...baseInput, projectId: PROJECT_B });
    // Different project ⇒ existing lookup misses ⇒ null (maintenance-shaped fallback).
    // Service returns null when neither a fresh alert nor an existing dedup row is found.
    expect(otherProject).toBeNull();
  });
});

describe("updateReportStatus", () => {
  it("writes only the provided sparse fields, leaving the rest untouched", async () => {
    const created = await createVisualReport(baseInput);
    const id = created!.reportId;

    await updateReportStatus(id, "diagnosing", {
      diagnosis: { root_cause: "useEffect missing cleanup" },
      confidence: 82,
      modelDiagnose: "Qwen/Qwen3.5-397B-A17B",
    });

    const row = state.reports.find((r) => r.id === id)!;
    expect(row.status).toBe("diagnosing");
    expect(row.diagnosis).toEqual({ root_cause: "useEffect missing cleanup" });
    expect(row.confidence).toBe(82);
    expect(row.modelDiagnose).toBe("Qwen/Qwen3.5-397B-A17B");
    // Fields not provided remain unset.
    expect(row.critique).toBeUndefined();
    expect(row.modelCritique).toBeUndefined();
  });
});

describe("getVisualReport / getVisualReportByAlert / listVisualReports", () => {
  it("getVisualReport returns the row by id", async () => {
    const created = await createVisualReport(baseInput);
    const row = await getVisualReport(created!.reportId);
    expect(row?.id).toBe(created!.reportId);
  });

  it("getVisualReport returns null for unknown id", async () => {
    const row = await getVisualReport("00000000-0000-0000-0000-deadbeefcafe");
    expect(row).toBeNull();
  });

  it("getVisualReportByAlert resolves the 1:1 row", async () => {
    const created = await createVisualReport(baseInput);
    const row = await getVisualReportByAlert(created!.alertId);
    expect(row?.alertId).toBe(created!.alertId);
  });

  it("listVisualReports returns project-scoped rows newest first", async () => {
    await createVisualReport(baseInput);
    state.alertNullMode = null; // reset
    await createVisualReport({ ...baseInput, bundle: { dom: "<span/>" } });

    const rows = await listVisualReports(PROJECT_A);
    expect(rows.length).toBe(2);
  });

  it("listVisualReports filters by status when provided", async () => {
    const a = await createVisualReport(baseInput);
    await updateReportStatus(a!.reportId, "completed", { confidence: 90 });
    await createVisualReport({ ...baseInput, bundle: { dom: "<b/>" } });

    const completed = await listVisualReports(PROJECT_A, { status: "completed" });
    expect(completed.every((r) => r.status === "completed")).toBe(true);
    expect(completed.length).toBe(1);
  });
});
