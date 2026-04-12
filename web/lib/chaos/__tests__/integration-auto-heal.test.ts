/**
 * Integration Chaos Test: Auto-Heal Cascade
 *
 * Tests triggerAutoRollback under failure conditions:
 * - Vercel API fails → alert stays unresolved with error note
 * - No previous deploy → graceful skip
 * - Successful rollback → alert resolved
 * - No cooldown → double rollback documented as gap
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, TABLE_MOCKS } from "./helpers/mock-db";
import { chaosTest } from "../harness";

// ── Setup mocks ─────────────────────────────────────────────────────────────

const { db, control } = createMockDb();

vi.mock("@/lib/db", () => ({ db, ...TABLE_MOCKS }));

const mockGetLastDeploy = vi.fn();
const mockRollback = vi.fn();
vi.mock("@/lib/services/vercel-api", () => ({
  getLastSuccessfulDeploy: (...args: unknown[]) => mockGetLastDeploy(...args),
  rollbackToDeployment: (...args: unknown[]) => mockRollback(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

const { triggerAutoRollback } = await import("@/lib/services/auto-rollback");

// ── Helpers ─────────────────────────────────────────────────────────────────

const baseOpts = {
  alertId: "alert-1",
  token: "vercel-token",
  teamId: "team-1",
  vercelProjectId: "prj-abc",
  projectName: "my-app",
};

const goodDeploy = {
  uid: "dpl_abc12345",
  url: "my-app.vercel.app",
  createdAt: Date.now(),
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Integration: Auto-Heal Cascade", () => {
  beforeEach(() => {
    control.reset();
    control.setDefaultSelectResult([]);
    mockGetLastDeploy.mockReset();
    mockRollback.mockReset();
    // Default: cooldown lock always acquired (not in cooldown).
    // Lock key format: `rollback:${service}:${projectId ?? projectName}`
    db.execute.mockResolvedValue({ rows: [{ key: "rollback:vercel:prj-abc" }] });
  });

  it("successful rollback resolves the alert", async () => {
    mockGetLastDeploy.mockResolvedValue(goodDeploy);
    // vercel-api.rollbackToDeployment returns { url } — the provider
    // abstraction (VercelProvider) passes that shape through, so the mock
    // must match it or the provider throws reading .url on undefined.
    mockRollback.mockResolvedValue({ url: "https://my-app.vercel.app" });

    await triggerAutoRollback(baseOpts);

    const updates = control.getUpdates();
    const resolveUpdate = updates.find((u) =>
      (u.set as Record<string, unknown>).isResolved === true
    );
    expect(resolveUpdate).toBeDefined();
    expect(mockRollback).toHaveBeenCalledTimes(1);
  });

  it("no previous deploy: skips rollback, updates alert body", async () => {
    mockGetLastDeploy.mockResolvedValue(null);

    await triggerAutoRollback(baseOpts);

    expect(mockRollback).not.toHaveBeenCalled();
    const updates = control.getUpdates();
    expect(updates.length).toBeGreaterThan(0);
    // Alert body updated with "no previous successful deployment"
    // (The update uses sql template, so we can't check the exact string easily,
    // but we verify an update happened and rollback was not called)
  });

  it("rollback failure: alert stays unresolved with error note", async () => {
    mockGetLastDeploy.mockResolvedValue(goodDeploy);
    mockRollback.mockRejectedValue(new Error("Vercel API 500: Internal Server Error"));

    const result = await chaosTest("rollback-failure", async () => {
      await triggerAutoRollback(baseOpts);
    });

    // Retry: 2 attempts (original + 1 retry)
    expect(mockRollback).toHaveBeenCalledTimes(2);

    // Alert NOT resolved
    const updates = control.getUpdates();
    const resolveUpdate = updates.find((u) =>
      (u.set as Record<string, unknown>).isResolved === true
    );
    expect(resolveUpdate).toBeUndefined();

    // Error was logged during retry
    expect(result.log.errors.some((e) => e.includes("[auto-rollback]"))).toBe(true);

    // Took at least 3 seconds (retry delay)
    expect(result.durationMs).toBeGreaterThanOrEqual(2500);
  });

  it("first attempt fails, retry succeeds", async () => {
    mockGetLastDeploy.mockResolvedValue(goodDeploy);
    mockRollback
      .mockRejectedValueOnce(new Error("Transient 502"))
      .mockResolvedValueOnce({ url: "https://my-app.vercel.app" });

    const result = await chaosTest("rollback-retry", async () => {
      await triggerAutoRollback(baseOpts);
    });

    expect(mockRollback).toHaveBeenCalledTimes(2);
    // First attempt logged
    expect(result.log.errors.some((e) => e.includes("[auto-rollback]"))).toBe(true);

    // Alert IS resolved (second attempt succeeded)
    const updates = control.getUpdates();
    const resolveUpdate = updates.find((u) =>
      (u.set as Record<string, unknown>).isResolved === true
    );
    expect(resolveUpdate).toBeDefined();
  });

  it("cooldown prevents second rollback within 10 minutes", async () => {
    mockGetLastDeploy.mockResolvedValue(goodDeploy);
    mockRollback.mockResolvedValue({ url: "https://my-app.vercel.app" });

    // Mock db.execute for the cron_locks cooldown check
    // First call: lock acquired (returns key)
    // Second call: lock held (returns empty — cooldown active)
    db.execute
      .mockResolvedValueOnce({ rows: [{ key: "rollback:vercel:prj-abc" }] }) // lock acquired
      .mockResolvedValueOnce({ rows: [] }); // cooldown active

    // First rollback executes
    await triggerAutoRollback(baseOpts);
    expect(mockRollback).toHaveBeenCalledTimes(1);

    // Second rollback blocked by cooldown
    await triggerAutoRollback(baseOpts);
    expect(mockRollback).toHaveBeenCalledTimes(1); // still 1 — blocked
  });

  it("does not throw on any failure path", async () => {
    // Vercel API completely unreachable
    mockGetLastDeploy.mockRejectedValue(new Error("ECONNREFUSED"));

    // Should not throw — all errors are caught internally
    await expect(triggerAutoRollback(baseOpts)).resolves.toBeUndefined();
  });
});
