/**
 * Integration Chaos Test: Alert Storm Lifecycle
 *
 * Tests the full storm path across createAlertIfNew → storm detection →
 * notification routing → incident thread creation.
 *
 * 6 sequential alerts: 1-4 normal, 5th triggers storm, 6th joins storm.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, TABLE_MOCKS } from "./helpers/mock-db";

// ── Setup mocks ─────────────────────────────────────────────────────────────

const { db, control } = createMockDb();

vi.mock("@/lib/db", () => ({
  db,
  ...TABLE_MOCKS,
  getUserProjectIds: vi.fn().mockResolvedValue([]),
  DEFAULT_AUTO_MERGE_CONFIG: {},
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => v,
  decryptConfig: () => ({}),
}));

const mockEnqueueAlert = vi.fn().mockResolvedValue(1);
vi.mock("@/lib/notifications/send", () => ({
  enqueueAlert: (...args: unknown[]) => mockEnqueueAlert(...args),
}));

vi.mock("@/lib/webhooks/outgoing", () => ({
  dispatchOutgoingWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/ai/status-page-automation", () => ({
  autoCreateIncident: vi.fn().mockResolvedValue(undefined),
}));

const mockSendIncidentThread = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/slack/send", () => ({
  sendAlertToSlack: vi.fn().mockResolvedValue(undefined),
  sendIncidentThread: (...args: unknown[]) => mockSendIncidentThread(...args),
}));

vi.mock("@/lib/telegram/send", () => ({
  sendAlertToTelegram: vi.fn().mockResolvedValue(undefined),
  sendIncidentStormToProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/mobile-push", () => ({
  sendMobilePush: vi.fn().mockResolvedValue(undefined),
}));

let fpCounter = 0;
vi.mock("@/lib/ai/fingerprint", () => ({
  computeErrorFingerprint: () => `fp-${++fpCounter}`,
}));

vi.mock("@/lib/ai/auto-analyze", () => ({
  autoAnalyzeAlert: vi.fn().mockResolvedValue(undefined),
}));

const { createAlertIfNew } = await import("@/lib/webhooks/shared");

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAlert(index: number) {
  return {
    severity: "warning" as const,
    title: `Error ${index}: something broke`,
    body: `Stack trace for error ${index}`,
    sourceIntegrations: ["capture"],
    isRead: false,
    isResolved: false,
  };
}

/**
 * Push DB selects for one createAlertIfNew call.
 * The function does: maintenance check, storm check, (recent if no storm),
 * plus several other selects for error patterns, auto-remediation, etc.
 * We use setDefaultSelectResult([]) to handle the unpredictable extra selects.
 */
function setupNormalAlert(recentCount: number) {
  control.pushSelectResult([]); // maintenance window → none
  control.pushSelectResult([]); // active storm → none
  const recent = Array.from({ length: recentCount }, (_, i) => ({ id: `a${i + 1}` }));
  control.pushSelectResult(recent); // recent alerts for storm check
}

function setupJoinStorm(stormId: string) {
  control.pushSelectResult([]); // maintenance → none
  control.pushSelectResult([{ id: stormId }]); // active storm → found
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Integration: Alert Storm Lifecycle", () => {
  beforeEach(() => {
    control.reset();
    control.setDefaultSelectResult([]);
    fpCounter = 0;
    mockEnqueueAlert.mockClear();
    mockSendIncidentThread.mockClear();
  });

  it("normal alert is enqueued for notification", async () => {
    setupNormalAlert(0); // no recent → no storm
    const result = await createAlertIfNew(makeAlert(1), "proj-1");

    expect(result).not.toBeNull();
    expect(mockEnqueueAlert).toHaveBeenCalledTimes(1);
  });

  it("5th alert triggers storm and creates incident thread", async () => {
    setupNormalAlert(4); // 4 recent → THIS is the 5th → storm
    const result = await createAlertIfNew(makeAlert(5), "proj-1");

    expect(result).not.toBeNull();
    expect(mockEnqueueAlert).toHaveBeenCalledTimes(1); // storm trigger gets enqueued
    expect(mockSendIncidentThread).toHaveBeenCalledTimes(1);
  });

  it("alert joining existing storm does NOT get enqueued", async () => {
    setupJoinStorm("storm-1");
    const result = await createAlertIfNew(makeAlert(6), "proj-1");

    expect(result).not.toBeNull();
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
    expect(mockSendIncidentThread).not.toHaveBeenCalled();
  });

  it("4 recent alerts is NOT enough to trigger storm", async () => {
    setupNormalAlert(3); // only 3 recent → current is 4th, NOT 5th
    await createAlertIfNew(makeAlert(1), "proj-1");

    expect(mockSendIncidentThread).not.toHaveBeenCalled();
    expect(mockEnqueueAlert).toHaveBeenCalledTimes(1); // normal notification
  });

  it("maintenance window suppresses alert completely", async () => {
    control.pushSelectResult([{ id: "maint-1" }]); // active maintenance
    const result = await createAlertIfNew(makeAlert(1), "proj-1");

    expect(result).toBeNull();
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
  });

  it("dedup conflict returns null silently", async () => {
    setupNormalAlert(0);
    control.setInsertConflict(true);
    const result = await createAlertIfNew(makeAlert(1), "proj-1");

    expect(result).toBeNull();
    expect(mockEnqueueAlert).not.toHaveBeenCalled();
  });

  it("storm lifecycle summary: trigger → join → no double notification", async () => {
    // Phase 1: Storm trigger (5th alert)
    setupNormalAlert(4); // 4 recent found
    const stormResult = await createAlertIfNew(makeAlert(5), "proj-1");
    expect(stormResult).not.toBeNull();
    expect(mockEnqueueAlert).toHaveBeenCalledTimes(1); // storm trigger IS enqueued
    expect(mockSendIncidentThread).toHaveBeenCalledTimes(1); // incident thread created

    mockEnqueueAlert.mockClear();
    mockSendIncidentThread.mockClear();
    control.reset();
    control.setDefaultSelectResult([]);

    // Phase 2: Join storm (6th alert)
    setupJoinStorm("storm-1");
    const joinResult = await createAlertIfNew(makeAlert(6), "proj-1");
    expect(joinResult).not.toBeNull();
    expect(mockEnqueueAlert).not.toHaveBeenCalled(); // NOT enqueued
    expect(mockSendIncidentThread).not.toHaveBeenCalled(); // no duplicate thread
  });
});
