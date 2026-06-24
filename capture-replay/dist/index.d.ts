/**
 * @inariwatch/capture-replay — session replay integration for @inariwatch/capture.
 *
 * Usage:
 *   import { init } from "@inariwatch/capture"
 *   import { replayIntegration } from "@inariwatch/capture-replay"
 *
 *   init({
 *     dsn: process.env.INARIWATCH_DSN,
 *     projectId: "<uuid-from-dashboard>",
 *     integrations: [
 *       replayIntegration({ piiClassifier: "ai" })
 *     ]
 *   })
 *
 * The integration is browser-only — it no-ops in Node so it's safe to import
 * from isomorphic code paths.
 */
import type { Integration } from "@inariwatch/capture";
import { getSessionId, type ReplayConfig } from "./replay.js";
export type { ReplayConfig } from "./replay.js";
export type { PiiCategory, Classification, FieldFeatures } from "./pii-classifier.js";
/**
 * Create a replay integration. Pass the returned object in
 * `init({ integrations: [replayIntegration()] })`.
 *
 * Requires `projectId` on the root CaptureConfig — the server uses it to
 * identify the target workspace. Without it, the integration warns and
 * no-ops (fail-safe).
 */
export declare function replayIntegration(options?: ReplayConfig): Integration;
/** Re-export session id accessor so apps can correlate server-side errors. */
export { getSessionId };
//# sourceMappingURL=index.d.ts.map