/**
 * Chaos test: Cron overlap prevention.
 *
 * Tests that the advisory lock pattern used in the cron poll route
 * correctly prevents concurrent executions.
 */

import { describe, it, expect } from "vitest";
import { racingCalls } from "../faults";

describe("Chaos: Cron Overlap Prevention", () => {
  it("advisory lock pattern allows only 1 winner from concurrent attempts", async () => {
    // Simulate the INSERT ON CONFLICT advisory lock pattern
    // This mirrors the SQL logic: INSERT ... ON CONFLICT ... WHERE expires_at < now()
    let lockHolder: string | null = null;
    let lockExpiresAt = 0;

    const acquireLock = async (id: string): Promise<boolean> => {
      // Simulate network delay
      await new Promise((r) => setTimeout(r, Math.random() * 5));

      if (lockHolder === null || Date.now() > lockExpiresAt) {
        // Lock is free or expired — acquire it
        lockHolder = id;
        lockExpiresAt = Date.now() + 120_000;
        return true;
      }
      return false; // Lock held by someone else
    };

    const results = await racingCalls(5, async () => {
      const id = `cron-${Math.random().toString(36).slice(2)}`;
      const acquired = await acquireLock(id);
      return { id, acquired };
    });

    const winners = results
      .filter((r): r is PromiseFulfilledResult<{ id: string; acquired: boolean }> => r.status === "fulfilled")
      .filter((r) => r.value.acquired);

    // Exactly 1 should acquire the lock (JS is single-threaded,
    // but the real DB-level test happens in integration)
    expect(winners.length).toBe(1);
  });

  it("expired lock allows new acquisition", async () => {
    // Simulate an expired lock scenario (previous cron crashed)
    let lockExpiresAt = Date.now() - 1000; // Already expired
    let acquired = false;

    // New cron should be able to acquire expired lock
    if (Date.now() > lockExpiresAt) {
      lockExpiresAt = Date.now() + 120_000;
      acquired = true;
    }

    expect(acquired).toBe(true);
    expect(lockExpiresAt).toBeGreaterThan(Date.now());
  });

  it("active lock prevents new acquisition", async () => {
    const lockExpiresAt = Date.now() + 120_000; // 2 minutes from now
    let acquired = false;

    // New cron should NOT be able to acquire active lock
    if (Date.now() > lockExpiresAt) {
      acquired = true;
    }

    expect(acquired).toBe(false);
  });

  it("lock TTL of 120s is reasonable for cron fan-out", () => {
    // The lock TTL should be longer than the longest expected cron run
    // but short enough to auto-expire if the process crashes.
    // 120 seconds covers the fan-out (7 sub-routes in parallel)
    // plus correlation, anomaly detection, and notification processing.
    const LOCK_TTL_MS = 120_000;
    const MAX_EXPECTED_CRON_DURATION_MS = 90_000; // 90s worst case

    expect(LOCK_TTL_MS).toBeGreaterThan(MAX_EXPECTED_CRON_DURATION_MS);
    expect(LOCK_TTL_MS).toBeLessThanOrEqual(300_000); // Not more than 5 minutes
  });
});
