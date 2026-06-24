/**
 * Chaos test harness — captures console output and measures resources.
 *
 * Usage:
 *   const result = await chaosTest("ai-timeout", async (log) => {
 *     await callAI(...);
 *     log.errors; // captured console.error calls
 *   });
 */

export interface ChaosLog {
  errors: string[];
  warns: string[];
}

export interface ChaosResult<T> {
  log: ChaosLog;
  durationMs: number;
  memoryDeltaBytes: number;
  result?: T;
  error?: Error;
}

/**
 * Run a chaos test function with captured console output and timing.
 */
export async function chaosTest<T>(
  _name: string,
  fn: (log: ChaosLog) => Promise<T>,
): Promise<ChaosResult<T>> {
  const log: ChaosLog = { errors: [], warns: [] };

  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => log.errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => log.warns.push(args.map(String).join(" "));

  const memBefore = typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;
  const start = Date.now();

  let result: T | undefined;
  let error: Error | undefined;

  try {
    result = await fn(log);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }

  const durationMs = Date.now() - start;
  const memAfter = typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;

  return {
    log,
    durationMs,
    memoryDeltaBytes: memAfter - memBefore,
    result,
    error,
  };
}
