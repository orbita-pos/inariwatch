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
export {};
//# sourceMappingURL=browser.d.ts.map