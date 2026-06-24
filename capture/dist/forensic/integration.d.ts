/**
 * Integration export — adapts the forensic hook (`registerForensicHook`)
 * into the `@inariwatch/capture` Integration shape so it can be consumed via:
 *
 *   import { init } from "../types.js"
 *   import { forensicIntegration } from "@inariwatch/node-forensic"
 *
 *   init({
 *     dsn: process.env.INARIWATCH_DSN,
 *     integrations: [forensicIntegration()],
 *   })
 *
 * The forensic peer ships `registerForensicHook` because the hook is also
 * useful outside the capture pipeline (eBPF stitching, custom forwarders).
 * The Integration adapter is opt-in glue that buffers captures from the
 * hook and attaches them to the matching event during `onBeforeSend`.
 *
 * Match heuristic: forensic captures buffer up to `bufferSize` entries and
 * are paired to events by stack-line alignment (top of stack === top of
 * event.body second line). Best score wins; the picked capture is removed.
 */
import type { Integration } from "../types.js";
import type { ForensicCapture, ForensicOptions } from "./types.js";
export interface ForensicIntegrationConfig extends ForensicOptions {
    /** Max captures buffered for matching. Default 8. */
    bufferSize?: number;
}
export declare function forensicIntegration(config?: ForensicIntegrationConfig): Integration;
/** Test-only: inject a synthetic capture into the buffer. */
export declare function __pushCaptureForTesting(c: ForensicCapture): void;
/** Test-only: clear buffer and reset registration state. */
export declare function __resetForensicIntegrationForTesting(): void;
//# sourceMappingURL=integration.d.ts.map