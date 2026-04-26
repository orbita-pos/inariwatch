/**
 * SDK ↔ eBPF agent session-id stitching.
 *
 * The InariWatch eBPF agent writes runtime-exception events to its
 * cloud endpoint with PID + TID + nanosecond timestamp.  The forensic
 * SDK captures the *contents* of the throw (frame locals, closures,
 * receiver) in-process.  A correlation id is needed for the cloud-side
 * stitcher to join them — that id is the FullTrace `sessionId`.
 *
 * Because the eBPF probe runs in the kernel, it cannot reach into the
 * Node process to read the JS-side session id.  We bridge the two
 * worlds with a tiny per-process file:
 *
 *     /run/inariwatch/agents/{PID}.sess
 *
 * Schema (`iw.session.v1`):
 *
 *     {
 *       "schema":     "iw.session.v1",
 *       "session_id": "<uuid v4>",
 *       "pid":        <int>,
 *       "updated_ns": <bigint as integer>,
 *       "request_id": "<optional>",
 *       "user_id":    "<optional>"
 *     }
 *
 * The agent reads this file on the slow path (cached for 5s) when it
 * processes a `runtime_exception` event for the same PID.
 *
 * Operational notes:
 *   - Linux only.  On other platforms the install is a no-op so SDK
 *     code can call `installSessionFile` unconditionally.
 *   - Best-effort: any failure (permission denied on `/run`, ENOSPC,
 *     etc.) is swallowed.  Stitching is enrichment, never a hard
 *     dependency for capture or for the user's app.
 *   - Atomic writes: we write to `{PID}.sess.tmp` then `rename(2)` so
 *     the agent never sees a half-written file.
 *   - Cleanup: an `exit` listener removes the file on graceful
 *     shutdown.  On a hard crash the agent treats the orphan as stale
 *     via the `MAX_RECORD_AGE` window.
 *
 * Privacy:
 *   - The SDK is responsible for redaction.  Anything passed in
 *     `requestId` / `userId` lands in the file as-is.  Hash or
 *     pseudonymise before calling if your policy requires it.
 */
export interface SessionContext {
    /** FullTrace session id.  Required. */
    sessionId: string;
    /** Optional active request id.  Refresh via `updateRequestContext`. */
    requestId?: string;
    /** Optional authenticated user id. */
    userId?: string;
}
interface InstalledHandle {
    /** Absolute path to the session file.  Used by tests + uninstall. */
    filePath: string;
    /** Whether the install actually wrote a file (false on non-Linux). */
    active: boolean;
}
/**
 * Internal hook for tests.  Pass `null` to clear.
 *
 * @internal
 */
export declare function __setSessionDirForTest(dir: string | null): void;
/**
 * Publish the SDK's session context so the eBPF agent can correlate
 * its kernel-captured throws with the in-process forensic capture.
 *
 * Idempotent across calls: a second `installSessionFile` updates the
 * file in place rather than installing a second exit listener.
 *
 * @returns the absolute file path that was written, or `null` when no
 *          file was written (non-Linux, IO failure).
 */
export declare function installSessionFile(ctx: SessionContext): string | null;
/**
 * Update the request context inside the active session.  Useful when
 * the host app wraps every HTTP handler with AsyncLocalStorage and
 * wants the agent to know which request a throw belongs to.
 *
 * Calling without a prior `installSessionFile` is a no-op.
 */
export declare function updateRequestContext(opts: {
    requestId?: string;
    userId?: string;
}): boolean;
/**
 * Remove the session file and detach the exit listener.  Safe to call
 * even when nothing is installed.
 */
export declare function uninstallSessionFile(): void;
/**
 * Inspect whether a session file is currently installed.  Tests + debugging.
 *
 * @internal
 */
export declare function __sessionFileState(): InstalledHandle | null;
export {};
//# sourceMappingURL=session-file.d.ts.map