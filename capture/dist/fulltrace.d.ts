/**
 * FullTrace — session id propagation for causal debugging.
 *
 * Generates a stable per-user session id and injects it as `X-IW-Session-Id`
 * on every same-origin fetch/XHR. The backend reads the header and tags
 * Substrate I/O records + alerts with the same id, letting the dashboard
 * stitch frontend events ↔ backend events ↔ AI fix into one timeline.
 *
 * Design rules:
 *   - Browser-only. In Node.js this module is a no-op — the server is the
 *     receiver of the header, never the generator.
 *   - Backward compatible. If `fullTrace: false` the SDK behaves exactly
 *     like v0.7.x (no header, no cookie, no global). If `__INARIWATCH_SESSION__`
 *     is already set (e.g. by `@inariwatch/capture-replay`) we adopt that id
 *     instead of generating a new one — replay session and FullTrace session
 *     are the same concept, only one id can win.
 *   - Same-origin only by default. Adding a custom header to a cross-origin
 *     fetch promotes it to a "non-simple" CORS request, triggering a preflight
 *     that third-party APIs (Stripe, Algolia, …) won't allow. Users can opt
 *     into cross-origin propagation via `fullTrace: { allowCrossOrigin: true }`
 *     when their backend also lives off-origin and they control the CORS config.
 *   - Cookie + sessionStorage. Cookie keeps the session alive across tabs
 *     (one user, one timeline). sessionStorage is the fallback if cookies are
 *     blocked. Both are renewed on every emit so an inactive tab doesn't
 *     prematurely expire a real-time session.
 */
import type { FullTraceConfig } from "./types.js";
/**
 * Initialize FullTrace. Idempotent. Browser-only — no-ops in Node.js.
 *
 * Resolution order for the session id:
 *   1. `window.__INARIWATCH_SESSION__` (set by replay package)
 *   2. `iw_session` cookie
 *   3. `iw_session` sessionStorage
 *   4. Generate new UUID v4
 *
 * Whichever wins is then propagated to all three storages so the next read
 * (or a hydration boundary) finds it cheaply.
 */
export declare function initFullTrace(config?: FullTraceConfig): void;
/** Returns the active session id, or null if FullTrace was never initialized
 *  or we're running outside a browser. */
export declare function getSessionId(): string | null;
/** Re-anchor the session id (useful when a host app issues its own ids,
 *  e.g. from auth). Triggers a refresh of all three storages. */
export declare function setSessionId(id: string): void;
/**
 * Return a new RequestInit with the session header injected, or the original
 * init if injection is not appropriate. Never mutates the input.
 *
 * Used by breadcrumbs.ts in its globalThis.fetch interceptor.
 */
export declare function injectSessionHeader(url: string, init?: RequestInit): RequestInit | undefined;
/** Test seam — reset module state. Production code shouldn't call this. */
export declare function __resetFullTraceForTesting(): void;
//# sourceMappingURL=fulltrace.d.ts.map