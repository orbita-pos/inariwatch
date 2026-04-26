/**
 * Precursor stream — SKYNET §3 piece 3 (Track B).
 *
 * Why: at the moment of throw, stack + locals tell the AI WHAT failed.
 * Precursors tell it WHY NOW. A 30-second 1Hz ring buffer of event loop p99,
 * RSS trajectory, active handles, and near-miss counters. Snapshotted at
 * error flush time and attached to `evidence.precursors[]` of payload v2.
 *
 * Sources:
 *   - eventloop p99: `perf_hooks.monitorEventLoopDelay({ resolution: 10 })`,
 *     read + reset every second so each sample reflects the prior 1s slice.
 *   - rss: `process.memoryUsage().rss`.
 *   - active handles: `process._getActiveHandles().length` (private API,
 *     guarded — silently 0 if Node yanks it).
 *   - near-misses: `process.on('rejectionHandled')` increments a counter
 *     (a rejection that was unhandled at first tick but caught later).
 *   - retries: `node:diagnostics_channel` `undici:request:error` if undici is
 *     in use. opossum / axios callers can drive the counter manually via
 *     `recordRetry()` / `recordCircuitBreakerTrip()`.
 *
 * Graceful degradation:
 *   - Browser / Edge / sandboxed Node: `node:perf_hooks` import fails →
 *     fall back to a setTimeout(1) jitter probe. p99 becomes "max scheduling
 *     lag observed in window" — coarser but still useful and never throws.
 *   - `process._getActiveHandles` missing → handles=0.
 *   - undici / opossum not installed → manual counters still work.
 *
 * Overhead budget (verified in test/precursors.test.mjs):
 *   - <1% CPU on a 1000 ops/s synthetic baseline.
 *   - <2 MB RAM (30 samples × ~80 bytes + monitor histogram).
 *
 * Zero deps.
 */
import type { Precursor } from "./types.js";
interface Sample {
    t: number;
    eventloopP99Ms: number;
    rssMb: number;
    activeHandles: number;
    nearMisses: number;
    retries: number;
    circuitBreakerTrips: number;
}
/**
 * Start the 1Hz sampler + counter hooks. Idempotent — second call is a no-op.
 * Cheap to call from `init()`; the timer is `unref`'d so it never holds a
 * Node process open by itself.
 */
export declare function initPrecursors(): void;
/** Stop sampling and detach all hooks. Safe to call when not initialized. */
export declare function stopPrecursors(): void;
/**
 * Compress the ring buffer into the sparse `Precursor[]` wire shape. Only
 * signals that meaningfully moved during the window are emitted; quiet
 * windows return `[]` so the payload stays small.
 *
 * Window seconds is computed from the first/last sample timestamps rather
 * than the constant — under load the sampler can drift a few hundred ms,
 * and the AI cares about real elapsed time, not the nominal cap.
 */
export declare function snapshotPrecursors(): Precursor[];
/** Public counter hooks for callers that wrap their own retry / breaker code. */
export declare function recordNearMiss(): void;
export declare function recordRetry(): void;
export declare function recordCircuitBreakerTrip(): void;
export declare function __resetPrecursorsForTesting(): void;
export declare function __forceSampleForTesting(): void;
export declare function __isPerfHooksActiveForTesting(): boolean;
export declare function __waitForPerfHooksReadyForTesting(timeoutMs?: number): Promise<boolean>;
export declare function __getRingForTesting(): ReadonlyArray<Readonly<Sample>> | null;
export {};
//# sourceMappingURL=precursors.d.ts.map