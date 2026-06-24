/**
 * Phase 3.2 — A/B telemetry writer.
 *
 * Verifies the writer (a) inserts a row with the right shape on the
 * success path, (b) inserts a row on the FAILURE path too, (c) looks up
 * alertId from remediation_sessions when the caller passes null, and
 * (d) swallows DB errors so a Neon hiccup never aborts a remediation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbState = {
  inserts: [] as Record<string, unknown>[],
  selectShouldThrow: false,
  insertShouldThrow: false,
  alertIdInDb: "alert-from-db" as string | null,
};

vi.mock("../db.js", () => ({
  db: {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  if (dbState.selectShouldThrow) throw new Error("Neon select hiccup");
                  return Promise.resolve(
                    dbState.alertIdInDb !== null
                      ? [{ alertId: dbState.alertIdInDb }]
                      : [],
                  );
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(rows: Record<string, unknown>) {
          if (dbState.insertShouldThrow) throw new Error("Neon insert hiccup");
          dbState.inserts.push(rows);
          return Promise.resolve(undefined);
        },
      };
    },
  },
  organizations: {},
  projects: {},
  remediationSessions: { alertId: {} },
  codeIntelRemediationAb: {},
}));

import { writeAbTelemetry } from "../tools/code-intel-ab-telemetry.js";

beforeEach(() => {
  dbState.inserts.length = 0;
  dbState.selectShouldThrow = false;
  dbState.insertShouldThrow = false;
  dbState.alertIdInDb = "alert-from-db";
});

afterEach(() => {
  // ensure no test poisons subsequent ones
  dbState.inserts.length = 0;
});

describe("writeAbTelemetry — happy path", () => {
  it("inserts a row with the right shape on success", async () => {
    await writeAbTelemetry({
      sessionId: "session-1",
      alertId: "alert-passed-in",
      engine: "v2",
      workspacePct: 50,
      turnCount: 7,
      success: true,
      costUsd: null,
      durationMs: 12345,
      startedAt: new Date("2026-05-02T10:00:00Z"),
      finishedAt: new Date("2026-05-02T10:00:12Z"),
      failureReason: null,
    });
    expect(dbState.inserts.length).toBe(1);
    const row = dbState.inserts[0]!;
    expect(row.alertId).toBe("alert-passed-in");
    expect(row.remediationSessionId).toBe("session-1");
    expect(row.engine).toBe("v2");
    expect(row.workspacePct).toBe(50);
    expect(row.turnCount).toBe(7);
    expect(row.success).toBe(true);
    expect(row.costUsd).toBeNull();
    expect(row.durationMs).toBe(12345);
    expect(row.failureReason).toBeNull();
  });
});

describe("writeAbTelemetry — failure path also recorded", () => {
  it("writes success=false rows just as it writes successes", async () => {
    await writeAbTelemetry({
      sessionId: "session-fail",
      alertId: "alert-x",
      engine: "v1",
      workspacePct: null,
      turnCount: 40,
      success: false,
      costUsd: null,
      durationMs: 60000,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: "Agent did not submit fix after 40 turns",
    });
    expect(dbState.inserts.length).toBe(1);
    const row = dbState.inserts[0]!;
    expect(row.success).toBe(false);
    expect(row.failureReason).toMatch(/did not submit fix/);
  });

  it("clamps failure_reason to 500 chars", async () => {
    const long = "x".repeat(2000);
    await writeAbTelemetry({
      sessionId: "s",
      alertId: "a",
      engine: "v1",
      workspacePct: null,
      turnCount: 1,
      success: false,
      costUsd: null,
      durationMs: 0,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: long,
    });
    const row = dbState.inserts[0]!;
    expect((row.failureReason as string).length).toBe(500);
  });
});

describe("writeAbTelemetry — alertId fallback lookup", () => {
  it("uses the looked-up alertId when caller passes null", async () => {
    dbState.alertIdInDb = "looked-up-alert";
    await writeAbTelemetry({
      sessionId: "session-1",
      alertId: null,
      engine: "v2",
      workspacePct: null,
      turnCount: 3,
      success: true,
      costUsd: null,
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: null,
    });
    expect(dbState.inserts.length).toBe(1);
    expect(dbState.inserts[0]!.alertId).toBe("looked-up-alert");
  });

  it("skips the row when no alertId can be resolved", async () => {
    dbState.alertIdInDb = null;
    await writeAbTelemetry({
      sessionId: "session-orphan",
      alertId: null,
      engine: "v2",
      workspacePct: null,
      turnCount: 3,
      success: true,
      costUsd: null,
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: null,
    });
    expect(dbState.inserts.length).toBe(0);
  });

  it("treats a select throw as 'no alertId' and skips the row", async () => {
    dbState.selectShouldThrow = true;
    await writeAbTelemetry({
      sessionId: "session-1",
      alertId: null,
      engine: "v2",
      workspacePct: null,
      turnCount: 3,
      success: true,
      costUsd: null,
      durationMs: 100,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: null,
    });
    expect(dbState.inserts.length).toBe(0);
  });
});

describe("writeAbTelemetry — DB errors never bubble", () => {
  it("swallows insert errors silently (no throw)", async () => {
    dbState.insertShouldThrow = true;
    await expect(
      writeAbTelemetry({
        sessionId: "s",
        alertId: "a",
        engine: "v1",
        workspacePct: null,
        turnCount: 1,
        success: true,
        costUsd: null,
        durationMs: 0,
        startedAt: new Date(),
        finishedAt: new Date(),
        failureReason: null,
      }),
    ).resolves.toBeUndefined();
    expect(dbState.inserts.length).toBe(0);
  });
});

describe("writeAbTelemetry — costUsd serialisation", () => {
  it("forwards cost as a string when present (Drizzle numeric expects string)", async () => {
    await writeAbTelemetry({
      sessionId: "s",
      alertId: "a",
      engine: "v2",
      workspacePct: null,
      turnCount: 5,
      success: true,
      costUsd: 0.42,
      durationMs: 1000,
      startedAt: new Date(),
      finishedAt: new Date(),
      failureReason: null,
    });
    expect(dbState.inserts[0]!.costUsd).toBe("0.42");
  });
});
