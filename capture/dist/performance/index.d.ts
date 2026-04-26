/**
 * @inariwatch/capture-performance — Web Vitals integration for @inariwatch/capture.
 *
 * Measures the five Core Web Vitals Google actually ranks on in 2026:
 *   • LCP  — Largest Contentful Paint
 *   • INP  — Interaction to Next Paint (replaced FID in 2024)
 *   • CLS  — Cumulative Layout Shift
 *   • FCP  — First Contentful Paint
 *   • TTFB — Time to First Byte
 *
 * Each metric is reported once per page load (rating: good/needs-improvement/poor).
 * Forwarded to InariWatch via `captureLog` so it lands in the same alert stream
 * as errors — no separate ingestion endpoint needed.
 *
 * Usage:
 *   import { init } from "../types.js"
 *   import { performanceIntegration } from "@inariwatch/capture-performance"
 *
 *   init({
 *     dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     integrations: [performanceIntegration()],
 *   })
 */
import type { Integration } from "../types.js";
export interface PerformanceOptions {
    /**
     * Which metrics to collect. Omit a metric to skip its observer entirely —
     * cheaper than letting it fire and ignoring the result.
     */
    metrics?: Array<"LCP" | "INP" | "CLS" | "FCP" | "TTFB">;
    /**
     * Only report metrics whose rating is at or above this level. Defaults to
     * `"needs-improvement"` so you aren't spammed with good-performance noise.
     *   - `"good"`               — report everything
     *   - `"needs-improvement"`  — skip metrics rated `good` (default)
     *   - `"poor"`               — only report poor-rated metrics
     */
    minRating?: "good" | "needs-improvement" | "poor";
    /**
     * Custom callback invoked for every reported metric. Useful for piping
     * metrics into your own analytics on top of InariWatch.
     */
    onMetric?: (metric: PerformanceMetric) => void;
    /**
     * Include `location.pathname` in the metric metadata. Enabled by default
     * because per-route performance is usually what you want. Disable if your
     * app uses sensitive path tokens (magic-link URLs, password-reset flows,
     * user-id-in-path) you don't want leaving the browser.
     *
     * You can also pass a redactor to keep per-route grouping while stripping
     * dynamic segments: `redactPathname: (p) => p.replace(/\/[a-f0-9-]{36}/g, "/:id")`.
     */
    includePathname?: boolean;
    /** Custom pathname redactor. Overrides `includePathname: true` default passthrough. */
    redactPathname?: (pathname: string) => string;
}
export interface PerformanceMetric {
    name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
    value: number;
    rating: "good" | "needs-improvement" | "poor";
    /** First paint / first input delta used for the metric calculation. */
    delta: number;
    id: string;
    /** Navigation type that produced this metric — "navigate", "reload", etc. */
    navigationType: string;
}
/**
 * Create a performance integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (web-vitals is browser-only). Safe to import from
 * isomorphic code paths.
 */
export declare function performanceIntegration(options?: PerformanceOptions): Integration;
//# sourceMappingURL=index.d.ts.map