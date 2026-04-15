/**
 * Browser auto-init.
 *
 * Usage:
 *   <script>window.__INARIWATCH__ = { dsn: "...", integrations: [...] }</script>
 *   <script type="module">import "@inariwatch/capture/browser"</script>
 *
 * Reads config from `window.__INARIWATCH__`. Defaults to `{ session: true }`
 * (the legacy 60-second ring buffer that attaches on error).
 *
 * Full session replay lives in `@inariwatch/capture-replay`:
 *   window.__INARIWATCH__ = {
 *     projectId: "...",
 *     integrations: [replayIntegration()]
 *   }
 *
 * Browser-only — no-ops in Node.js.
 */
import { init } from "./client.js";
if (typeof window !== "undefined") {
    const windowConfig = window.__INARIWATCH__ ?? {};
    const merged = {
        session: true,
        ...windowConfig,
    };
    init(merged);
}
//# sourceMappingURL=browser.js.map