/**
 * Shared mock DB factory for integration chaos tests.
 *
 * Provides a chainable mock that mimics Drizzle ORM's query builder.
 * Mock at the DB boundary only — all business logic above runs real.
 *
 * Usage:
 *   const { db, control } = createMockDb();
 *   control.pushSelectResult([{ id: "alert-1" }]);
 *   // ... vi.mock("@/lib/db", () => ({ db, alerts: {...}, ... }));
 */

import { vi } from "vitest";

export interface MockDbControl {
  /** Push a result that the next db.select()...where()... will return */
  pushSelectResult(rows: unknown[]): void;
  /** Get all values passed to db.insert().values() */
  getInserts(): { table: string; values: unknown }[];
  /** Get all values passed to db.update().set() */
  getUpdates(): { set: unknown; where?: unknown }[];
  /** Get all deletes tracked */
  getDeletes(): unknown[];
  /** Control whether INSERT ON CONFLICT returns empty (simulates dedup hit) */
  setInsertConflict(shouldConflict: boolean): void;
  /** Reset all state between tests */
  reset(): void;
  /** Get the raw select call count */
  selectCallCount: number;
  /** Set default for selects that exceed the queue */
  setDefaultSelectResult(rows: unknown[]): void;
}

export function createMockDb() {
  let selectResults: unknown[][] = [];
  let selectIndex = 0;
  const inserts: { table: string; values: unknown }[] = [];
  const updates: { set: unknown; where?: unknown }[] = [];
  const deletes: unknown[] = [];
  let insertShouldConflict = false;
  let insertCounter = 0;
  let defaultSelectResult: unknown[] = [];

  function chainableSelect(result: unknown[]) {
    // Make result array-like but also have .limit() and .orderBy() methods
    // so code can use it with or without .limit()
    function makeWhereResult() {
      const arr = [...result] as unknown[] & {
        limit: ReturnType<typeof vi.fn>;
        orderBy: ReturnType<typeof vi.fn>;
        then: undefined; // not a promise
      };
      arr.limit = vi.fn().mockReturnValue(result);
      arr.orderBy = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue(result),
      });
      return arr;
    }

    const chain = {
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue(makeWhereResult()),
          }),
        }),
        where: vi.fn().mockReturnValue(makeWhereResult()),
      }),
    };
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => {
      const idx = selectIndex++;
      return chainableSelect(selectResults[idx] ?? defaultSelectResult);
    }),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((v: unknown) => {
        insertCounter++;
        inserts.push({ table: "unknown", values: v });
        const row = { id: `mock-${insertCounter}`, createdAt: new Date(), ...(v as object) };
        return {
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue(insertShouldConflict ? [] : [row]),
          }),
          returning: vi.fn().mockReturnValue([row]),
        };
      }),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((s: unknown) => {
        updates.push({ set: s });
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),

    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((w: unknown) => {
        deletes.push(w);
        return Promise.resolve();
      }),
    })),

    execute: vi.fn().mockResolvedValue({ rows: [] }),

    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(db);
    }),
  };

  function setDefaultSelectResult(rows: unknown[]) {
    defaultSelectResult = rows;
  }

  const control: MockDbControl = {
    pushSelectResult(rows: unknown[]) {
      selectResults.push(rows);
    },
    getInserts() {
      return inserts;
    },
    getUpdates() {
      return updates;
    },
    getDeletes() {
      return deletes;
    },
    setInsertConflict(shouldConflict: boolean) {
      insertShouldConflict = shouldConflict;
    },
    reset() {
      selectResults = [];
      selectIndex = 0;
      inserts.length = 0;
      updates.length = 0;
      deletes.length = 0;
      insertShouldConflict = false;
      insertCounter = 0;
      db.execute.mockClear();
    },
    /** Set default for any select call that exceeds the queue (prevents crashes) */
    setDefaultSelectResult: setDefaultSelectResult,
    get selectCallCount() {
      return selectIndex;
    },
  };

  return { db, control };
}

/** Standard table column mocks matching Drizzle schema references */
export const TABLE_MOCKS = {
  alerts: { id: "id", projectId: "projectId", title: "title", isResolved: "isResolved", createdAt: "createdAt", fingerprint: "fingerprint", severity: "severity", body: "body" },
  incidentStorms: { id: "id", projectId: "projectId", status: "status" },
  projectIntegrations: { id: "id", isActive: "isActive", projectId: "projectId", service: "service" },
  projects: { id: "id", userId: "userId", name: "name", organizationId: "organizationId" },
  users: { id: "id", plan: "plan" },
  maintenanceWindows: { id: "id", projectId: "projectId", startsAt: "startsAt", endsAt: "endsAt" },
  notificationChannels: { id: "id", userId: "userId", isActive: "isActive", verifiedAt: "verifiedAt", type: "type", minSeverity: "minSeverity" },
  notificationQueue: { id: "id", status: "status", priority: "priority" },
  notificationLogs: { id: "id", channelId: "channelId", alertId: "alertId" },
  escalationRules: { id: "id", projectId: "projectId", isActive: "isActive", targetType: "targetType", minSeverity: "minSeverity" },
  organizationMembers: { userId: "userId", organizationId: "organizationId", role: "role" },
  remediationSessions: { id: "id", alertId: "alertId", projectId: "projectId", status: "status" },
  errorPatterns: { id: "id", fingerprint: "fingerprint" },
  substrateRecordings: { id: "id", alertId: "alertId" },
};
