/**
 * Breadcrumbs — automatic trail of actions before a crash.
 * Ring buffer of last 30 events: console, fetch, custom.
 * Secrets are scrubbed from messages automatically.
 */
import type { Breadcrumb } from "./types.js";
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