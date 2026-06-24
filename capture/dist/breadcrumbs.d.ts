/**
 * Breadcrumbs — automatic trail of actions before a crash.
 * Ring buffer of last 30 events: console, fetch, custom.
 * Secrets are scrubbed from messages automatically.
 *
 * Also the injection point for FullTrace's X-IW-Session-Id header — we
 * already wrap globalThis.fetch here for breadcrumb capture, so adding
 * one header to the same wrapper avoids a second monkey-patch.
 */
import type { Breadcrumb } from "./types.js";
/** Strip sensitive query params from URLs */
export declare function scrubUrl(url: string): string;
export declare function addBreadcrumb(crumb: Partial<Breadcrumb> & {
    message: string;
}): void;
export declare function getBreadcrumbs(): Breadcrumb[];
/**
 * Auto-intercept console and fetch to record breadcrumbs.
 * Called once from init(). Safe to call multiple times (idempotent).
 */
export declare function initBreadcrumbs(): void;
//# sourceMappingURL=breadcrumbs.d.ts.map