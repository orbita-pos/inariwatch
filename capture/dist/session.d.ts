/**
 * Browser session recording via rrweb.
 *
 * Records DOM interactions (clicks, inputs, navigation) in a ring buffer.
 * On error, the buffer is flushed and attached to the error event as sessionEvents.
 *
 * rrweb is loaded dynamically (optional peer dependency) — the SDK stays zero-deps
 * for Node.js users who don't need browser recording.
 */
import type { SessionConfig, SessionEvent, CaptureConfig } from "./types.js";
/** Returns current session events (called during error flush). */
export declare function getSessionEvents(): SessionEvent[];
/** Initialize session recording. Browser-only — no-ops in Node.js. */
export declare function initSession(config: SessionConfig, captureConfig: CaptureConfig): Promise<void>;
//# sourceMappingURL=session.d.ts.map