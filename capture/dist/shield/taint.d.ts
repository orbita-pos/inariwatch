/**
 * Taint tracking — marks user inputs as "tainted" and checks if they
 * reach dangerous sinks (database queries, shell commands, file ops).
 *
 * Uses a per-request Map<string, TaintSource> to track tainted strings.
 * Cleared after each request to prevent memory leaks.
 */
export interface TaintSource {
    /** Where the input came from: "req.query.q", "req.body.name", "req.params.id" */
    label: string;
    /** The original value (truncated for reporting) */
    value: string;
}
/** Mark a string as tainted (came from user input). */
export declare function markTainted(input: unknown, source: string): void;
/** Mark all values in an object as tainted (e.g. req.query, req.body). */
export declare function markObjectTainted(obj: unknown, prefix: string): void;
/** Check if a string argument contains any tainted input. */
export declare function checkTaint(sinkArg: string, minLength?: number): {
    tainted: string;
    source: TaintSource;
} | null;
/** Run a function with a fresh per-request taint store. */
export declare function runWithTaintStore<T>(fn: () => T): T;
/** Clear current taint store (call at end of request). */
export declare function clearTaint(): void;
//# sourceMappingURL=taint.d.ts.map