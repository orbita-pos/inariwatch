/**
 * Tests for VAR product metrics emitter.
 *
 * The contract is narrow but absolute:
 *   1. emit() never throws — even when the DB is down.
 *   2. emit() never blocks — returns void synchronously.
 *   3. flushMetrics() actually waits for all in-flight inserts.
 *
 * If any of these regress, every endpoint that calls emit() risks adding
 * latency or crashing on a telemetry blip. Lock them down hard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ─────────────────────────────────────────────────────────────────

const insertSpy = vi.fn();
let insertResolves = true;
const insertedRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => {
        insertedRows.push(row);
        insertSpy();
        if (!insertResolves) return Promise.reject(new Error("DB down"));
        return Promise.resolve();
      },
    }),
  },
  // The helper imports `productMetrics as productMetricsTable` from the
  // schema barrel — keep it as a placeholder; the mocked insert() ignores it.
  productMetrics: { name: "product_metrics" },
}));

import { productMetrics, VAR_EVENTS } from "@/lib/telemetry/product-metrics";

beforeEach(async () => {
  insertSpy.mockClear();
  insertedRows.length = 0;
  insertResolves = true;
  await productMetrics.flushMetrics();
});

describe("productMetrics.emit", () => {
  it("returns synchronously (no await needed by callers)", () => {
    const result = productMetrics.emit(VAR_EVENTS.SESSION_ID_PROPAGATED);
    expect(result).toBeUndefined();
  });

  it("inserts a row with the canonical event name", async () => {
    productMetrics.emit(VAR_EVENTS.SESSION_ID_PROPAGATED);
    await productMetrics.flushMetrics();

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertedRows[0]).toMatchObject({
      event: "session_id_propagated",
      organizationId: null,
      userId: null,
    });
  });

  it("passes through all EmitOptions fields", async () => {
    productMetrics.emit(VAR_EVENTS.WHATIF_REPLAY_COMPUTED, {
      organizationId: "org-1",
      userId: "user-1",
      valueNumeric: 42.5,
      valueText: "fix-abc",
      metadata: { foo: "bar" },
    });
    await productMetrics.flushMetrics();

    expect(insertedRows[0]).toMatchObject({
      event: "whatif_replay_computed",
      organizationId: "org-1",
      userId: "user-1",
      valueNumeric: 42.5,
      valueText: "fix-abc",
      metadata: { foo: "bar" },
    });
  });

  it("never throws when the DB rejects (telemetry must not break callers)", async () => {
    insertResolves = false;

    // Calling emit synchronously must not throw — the rejection happens later
    // inside the fire-and-forget promise.
    expect(() => productMetrics.emit(VAR_EVENTS.GATE_FAILED)).not.toThrow();

    // flushMetrics waits via Promise.allSettled, so it shouldn't throw either.
    await expect(productMetrics.flushMetrics()).resolves.toBeUndefined();

    // The insert was attempted, just rejected.
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("supports free-form event strings (escape hatch for prototyping)", async () => {
    productMetrics.emit("custom_event_for_testing");
    await productMetrics.flushMetrics();

    expect(insertedRows[0]).toMatchObject({ event: "custom_event_for_testing" });
  });

  it("defaults nullable opts to null (not undefined) so DB inserts stay typed", async () => {
    productMetrics.emit(VAR_EVENTS.SESSION_ID_RECEIVED);
    await productMetrics.flushMetrics();

    const row = insertedRows[0] as Record<string, unknown>;
    expect(row.organizationId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.valueNumeric).toBeNull();
    expect(row.valueText).toBeNull();
    expect(row.metadata).toBeNull();
  });
});

describe("productMetrics.flushMetrics", () => {
  it("waits for all pending inserts (test seam — not for prod)", async () => {
    productMetrics.emit(VAR_EVENTS.SESSION_ID_PROPAGATED);
    productMetrics.emit(VAR_EVENTS.SESSION_ID_RECEIVED);
    productMetrics.emit(VAR_EVENTS.SESSION_CORRELATED_TO_ALERT);

    expect(insertSpy).toHaveBeenCalledTimes(3); // synchronous insert call

    await productMetrics.flushMetrics();
    // After flush, all promises have settled. No pending state.
    expect(insertedRows).toHaveLength(3);
  });

  it("returns immediately when there are no pending emits", async () => {
    const start = Date.now();
    await productMetrics.flushMetrics();
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("VAR_EVENTS constants", () => {
  it("uses snake_case strings (lock down convention)", () => {
    for (const value of Object.values(VAR_EVENTS)) {
      expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("includes all Q1 foundation events", () => {
    expect(VAR_EVENTS.SESSION_ID_PROPAGATED).toBe("session_id_propagated");
    expect(VAR_EVENTS.SESSION_ID_RECEIVED).toBe("session_id_received");
    expect(VAR_EVENTS.SESSION_CORRELATED_TO_ALERT).toBe("session_correlated_to_alert");
    expect(VAR_EVENTS.SESSION_CORRELATED_TO_SUBSTRATE).toBe("session_correlated_to_substrate");
  });
});
