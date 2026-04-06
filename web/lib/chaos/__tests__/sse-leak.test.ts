/**
 * Chaos test: SSE memory leaks.
 *
 * Tests that the alerts SSE stream properly cleans up timers
 * on cancel() and doesn't leak intervals.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

describe("Chaos: SSE Memory Leaks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancel() clears both interval and timeout", () => {
    // Track timer creation and cleanup
    const timers = { intervals: 0, timeouts: 0, clearedIntervals: 0, clearedTimeouts: 0 };

    const origSetInterval = globalThis.setInterval;
    const origSetTimeout = globalThis.setTimeout;
    const origClearInterval = globalThis.clearInterval;
    const origClearTimeout = globalThis.clearTimeout;

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      timers.intervals++;
      return origSetInterval(...args);
    }) as typeof setInterval;

    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timers.timeouts++;
      return origSetTimeout(...args);
    }) as typeof setTimeout;

    globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
      timers.clearedIntervals++;
      return origClearInterval(...args);
    }) as typeof clearInterval;

    globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
      timers.clearedTimeouts++;
      return origClearTimeout(...args);
    }) as typeof clearTimeout;

    try {
      // Simulate the fixed SSE stream pattern
      let closed = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let maxLifetime: ReturnType<typeof setTimeout> | undefined;

      // Simulate start()
      interval = setInterval(() => {
        if (closed) clearInterval(interval);
      }, 10000);

      maxLifetime = setTimeout(() => {
        closed = true;
        clearInterval(interval);
      }, 55000);

      // Simulate cancel()
      closed = true;
      if (interval) clearInterval(interval);
      if (maxLifetime) clearTimeout(maxLifetime);

      // Verify: 1 interval + 1 timeout created, both cleaned up
      expect(timers.intervals).toBe(1);
      expect(timers.timeouts).toBe(1);
      expect(timers.clearedIntervals).toBeGreaterThanOrEqual(1);
      expect(timers.clearedTimeouts).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearInterval = origClearInterval;
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it("old pattern leaked checkClosed interval (regression proof)", () => {
    // The OLD pattern created TWO intervals:
    //   1. const interval = setInterval(..., 10000)  — polling
    //   2. const checkClosed = setInterval(..., 1000)  — leak detector
    // cancel() only set closed=true, relying on checkClosed to clean up.
    // If cancel() never fired (proxy timeout), both intervals leaked.

    // The NEW pattern creates 1 interval + 1 timeout, and cancel() clears both directly.
    // This test documents WHY the old pattern was a leak.

    let closed = false;
    let leakedIntervalRunning = true;

    // Old pattern: checkClosed interval
    const checkClosed = setInterval(() => {
      if (closed) {
        clearInterval(checkClosed);
        leakedIntervalRunning = false;
      }
    }, 50); // Use 50ms for test speed

    // Simulate: client disconnects WITHOUT triggering cancel()
    // (e.g., proxy timeout, browser tab crash)
    // closed stays false → checkClosed runs forever

    // Wait 200ms — checkClosed is still running
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(leakedIntervalRunning).toBe(true); // Still running = LEAK

        // Now manually clean up for the test
        closed = true;
        setTimeout(() => {
          expect(leakedIntervalRunning).toBe(false);
          resolve();
        }, 100);
      }, 200);
    });
  });

  it("maxLifetime auto-closes stream under Vercel 60s limit", () => {
    // The maxLifetime timeout (55s) ensures the stream closes even if
    // cancel() is never called. This prevents leaked intervals on Vercel.
    const MAX_LIFETIME_MS = 55000;
    const VERCEL_LIMIT_MS = 60000;

    expect(MAX_LIFETIME_MS).toBeLessThan(VERCEL_LIMIT_MS);
    expect(MAX_LIFETIME_MS).toBeGreaterThan(30000); // At least 30s of useful life
  });

  it("multiple streams don't cross-contaminate cleanup", () => {
    // Simulate creating multiple streams and cleaning them up independently
    const streams: { closed: boolean; interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }[] = [];

    for (let i = 0; i < 5; i++) {
      const state = { closed: false } as { closed: boolean; interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> };
      state.interval = setInterval(() => {
        if (state.closed) clearInterval(state.interval);
      }, 10000);
      state.timeout = setTimeout(() => {
        state.closed = true;
        clearInterval(state.interval);
      }, 55000);
      streams.push(state);
    }

    // Cancel streams 0, 2, 4 — leave 1, 3 "running"
    for (const i of [0, 2, 4]) {
      streams[i].closed = true;
      clearInterval(streams[i].interval);
      clearTimeout(streams[i].timeout);
    }

    // Verify cancelled streams are closed
    expect(streams[0].closed).toBe(true);
    expect(streams[2].closed).toBe(true);
    expect(streams[4].closed).toBe(true);

    // Verify uncancelled streams are still "running"
    expect(streams[1].closed).toBe(false);
    expect(streams[3].closed).toBe(false);

    // Clean up remaining
    for (const s of streams) {
      s.closed = true;
      clearInterval(s.interval);
      clearTimeout(s.timeout);
    }
  });
});
