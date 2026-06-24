/**
 * Browser auto-init + Capture Awake proactive monitoring.
 *
 * Usage:
 *   <script>window.__INARIWATCH__ = { dsn: "...", integrations: [...] }</script>
 *   <script type="module">import "@inariwatch/capture/browser"</script>
 *
 * Reads config from `window.__INARIWATCH__`. Defaults to `{ session: true }`.
 *
 * Proactive monitoring (Capture Awake) runs automatically — detects Web Vitals,
 * Long Animation Frames, broken resources, slow images, rage clicks, memory leaks,
 * and more. Opt out: `window.__INARIWATCH__ = { awake: false }`.
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