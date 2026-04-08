/**
 * Browser auto-init with session recording.
 *
 * Usage: import "@inariwatch/capture/browser"
 *
 * Reads config from window.__INARIWATCH__ or defaults to { session: true }.
 * Browser-only — no-ops in Node.js.
 */
import { init } from "./client.js";
if (typeof window !== "undefined") {
    const windowConfig = window.__INARIWATCH__ ?? {};
    init({
        session: true,
        ...windowConfig,
    });
}
//# sourceMappingURL=browser.js.map