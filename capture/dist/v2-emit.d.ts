/**
 * v2 wire emission — assembles a signed `ErrorEventV2` from the in-memory
 * `ErrorEvent` and hands it to the transport.
 *
 * Activation: opt-in. The SDK reads `CAPTURE_PAYLOAD_VERSION` (or its env
 * counterpart `INARIWATCH_PAYLOAD_VERSION`) at init. When the value is "2",
 * `client.ts` calls `prepareV2Payload` instead of sending the raw v1 event.
 *
 * All Node-only paths (filesystem keypair, source-context, git blame) are
 * isolated here. `client.ts` performs a dynamic import so the browser
 * bundle never pulls this file in.
 *
 * Backward compat:
 *   - If signing fails (no node:crypto, no writable home, etc.), this falls
 *     back to the v1 event unchanged. The server already accepts v1
 *     indefinitely.
 *   - If `getSourceContext` throws, we still build a v2 payload — without
 *     source slices but still signed. AI quality degrades, ingest works.
 */
import type { ErrorEvent } from "./types.js";
import { type ErrorEventV2 } from "./payload-v2.js";
/**
 * Prepare a v2 wire payload. Returns either the signed `ErrorEventV2` or the
 * unchanged v1 `ErrorEvent` if anything in the v2 path failed. Callers send
 * whichever they get.
 *
 * Why fall back instead of throwing: v2 is a delivery optimization, never a
 * correctness requirement. A signing failure must not lose the error event.
 */
export declare function prepareV2Payload(event: ErrorEvent): Promise<ErrorEventV2 | ErrorEvent>;
/** Resolve the active payload version from env at call time (lets tests flip it). */
export declare function resolvePayloadVersion(): "1" | "2";
//# sourceMappingURL=v2-emit.d.ts.map