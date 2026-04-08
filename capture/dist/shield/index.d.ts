/**
 * @inariwatch/capture/shield — Runtime security detection via source-to-sink tracking.
 *
 * Import this module to automatically hook dangerous sinks (database queries,
 * shell commands, file operations) and detect when unsanitized user input reaches them.
 *
 * Usage (auto, recommended for Next.js):
 *   import "@inariwatch/capture/shield"
 *
 * Usage (middleware, for Express/Fastify):
 *   import { shield } from "@inariwatch/capture/shield"
 *   app.use(shield())
 *   // or with block mode:
 *   app.use(shield({ mode: "block" }))
 */
import type { ShieldConfig } from "../types.js";
/**
 * Express/Connect middleware that marks request inputs as tainted
 * and optionally blocks threats.
 *
 * Usage:
 *   app.use(shield())
 *   app.use(shield({ mode: "block" }))
 */
export declare function shield(config?: ShieldConfig): (req: Record<string, unknown>, _res: unknown, next: () => void) => void;
export { markRequestTainted } from "./sources.js";
export { markTainted, markObjectTainted, runWithTaintStore, clearTaint } from "./taint.js";
//# sourceMappingURL=index.d.ts.map