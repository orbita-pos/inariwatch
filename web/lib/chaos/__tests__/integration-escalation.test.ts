/**
 * Integration Chaos Test: Escalation Without On-Call
 *
 * Tests the escalation engine when nobody is on-call,
 * the admin fallback path, and mixed rule scenarios.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, TABLE_MOCKS } from "./helpers/mock-db";
import { chaosTest } from "../harness";

// ── Setup mocks ─────────────────────────────────────────────────────────────

const { db, control } = createMockDb();

vi.mock("@/lib/db", () => ({
  db,
  ...TABLE_MOCKS,
  severityMeetsMinimum: (alertSeverity: string, minSeverity?: string) => {
    if (!minSeverity || minSeverity === "info") return true;
    const levels: Record<string, number> = { critical: 3, warning: 2, info: 1 };
    return (levels[alertSeverity] ?? 0) >= (levels[minSeverity] ?? 0);
  },
}));

const mockGetOnCallUserId = vi.fn().mockResolvedValue(null);
const mockGetOnCallChannel = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/on-call", () => ({
  getCurrentOnCallUserId: (...args: unknown[]) => mockGetOnCallUserId(...args),
  getOnCallChannel: (...args: unknown[]) => mockGetOnCallChannel(...args),
}));

const { triggerEscalation } = await import("@/lib/ai/escalation-engine");

// ── Helpers ─────────────────────────────────────────────────────────────────

const baseCtx = {
  alertId: "alert-1",
  projectId: "proj-1",
  reason: "fix_failed" as const,
  diagnosis: "Null reference in handler",
  confidence: 30,
};

function setupAlert(severity = "critical") {
  control.pushSelectResult([{
    id: "alert-1",
    projectId: "proj-1",
    severity,
    title: "CI failing",
    body: "Build failed",
  }]);
}

function setupRules(rules: { id: string; targetType: string; channelId?: string; minSeverity?: string }[]) {
  control.pushSelectResult(rules.map((r) => ({
    id: r.id,
    projectId: "proj-1",
    isActive: true,
    targetType: r.targetType,
    channelId: r.channelId ?? null,
    minSeverity: r.minSeverity ?? "info",
  })));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Integration: Escalation Without On-Call", () => {
  beforeEach(() => {
    control.reset();
    control.setDefaultSelectResult([]);
    mockGetOnCallUserId.mockReset().mockResolvedValue(null);
    mockGetOnCallChannel.mockReset().mockResolvedValue(null);
  });

  it("returns 0 when no alert found", async () => {
    control.pushSelectResult([]); // no alert
    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(0);
  });

  it("returns 0 when no escalation rules exist", async () => {
    setupAlert();
    control.pushSelectResult([]); // no rules
    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(0);
  });

  it("on_call_primary with nobody on-call: returns 0 and logs warning", async () => {
    const result = await chaosTest("escalation-no-oncall", async () => {
      setupAlert();
      setupRules([{ id: "rule-1", targetType: "on_call_primary" }]);

      return await triggerEscalation(baseCtx);
    });

    expect(result.result).toBe(0);
    expect(result.log.warns.some((w) => w.includes("[escalation] No on-call user"))).toBe(true);
  });

  it("channel target type notifies directly", async () => {
    setupAlert();
    setupRules([{ id: "rule-1", targetType: "channel", channelId: "ch-direct" }]);
    // Dedup check: no existing notification log
    control.pushSelectResult([]);

    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(1);

    const inserts = control.getInserts();
    const queueInsert = inserts.find((i) => (i.values as Record<string, unknown>).channelId === "ch-direct");
    expect(queueInsert).toBeDefined();
  });

  it("all_org_admins fallback notifies org admins", async () => {
    setupAlert();
    setupRules([{ id: "rule-2", targetType: "all_org_admins" }]);
    // Project org lookup
    control.pushSelectResult([{ organizationId: "org-1" }]);
    // Org admin members
    control.pushSelectResult([{ userId: "admin-1" }, { userId: "admin-2" }]);
    // Channels for admin-1
    control.pushSelectResult([{ id: "ch-admin-1" }]);
    // Channels for admin-2
    control.pushSelectResult([{ id: "ch-admin-2" }]);
    // Dedup checks (2 channels, 2 checks)
    control.pushSelectResult([]); // no existing log for ch-admin-1
    control.pushSelectResult([]); // no existing log for ch-admin-2

    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(2);
  });

  it("mixed rules: on_call fails silently, admin fallback succeeds", async () => {
    const result = await chaosTest("mixed-escalation", async () => {
      setupAlert();
      // Two rules: on_call_primary + all_org_admins
      control.pushSelectResult([
        { id: "rule-1", projectId: "proj-1", isActive: true, targetType: "on_call_primary", channelId: null, minSeverity: "info" },
        { id: "rule-2", projectId: "proj-1", isActive: true, targetType: "all_org_admins", channelId: null, minSeverity: "info" },
      ]);
      // all_org_admins path: project org → admin members → channels → dedup
      control.pushSelectResult([{ organizationId: "org-1" }]);
      control.pushSelectResult([{ userId: "admin-1" }]);
      control.pushSelectResult([{ id: "ch-admin-1" }]);
      control.pushSelectResult([]); // dedup check

      return await triggerEscalation(baseCtx);
    });

    // on_call returns 0 channels (logged), admin returns 1
    expect(result.result).toBe(1);
    expect(result.log.warns.some((w) => w.includes("[escalation] No on-call user"))).toBe(true);
  });

  it("dedup prevents double notification for same alert+channel", async () => {
    setupAlert();
    setupRules([{ id: "rule-1", targetType: "channel", channelId: "ch-1" }]);
    // Dedup check: already notified
    control.pushSelectResult([{ id: "existing-log-1" }]);

    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(0); // skipped due to dedup
  });

  it("severity filter respects minSeverity on rules", async () => {
    setupAlert("info"); // low severity alert
    setupRules([{ id: "rule-1", targetType: "channel", channelId: "ch-1", minSeverity: "critical" }]);

    const result = await triggerEscalation(baseCtx);
    expect(result).toBe(0); // info doesn't meet critical threshold
  });
});
