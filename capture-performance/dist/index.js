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
 *   import { init } from "@inariwatch/capture"
 *   import { performanceIntegration } from "@inariwatch/capture-performance"
 *
 *   init({
 *     dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
 *     integrations: [performanceIntegration()],
 *   })
 */
import { captureLog } from "@inariwatch/capture";
const DEFAULT_METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB"];
const RATING_ORDER = {
    good: 0,
    "needs-improvement": 1,
    poor: 2,
};
function meetsThreshold(rating, min) {
    const r = RATING_ORDER[rating];
    if (r === undefined)
        return true;
    return r >= RATING_ORDER[min];
}
/**
 * Create a performance integration. Pass to `init({ integrations: [...] })`.
 *
 * No-ops on the server (web-vitals is browser-only). Safe to import from
 * isomorphic code paths.
 */
export function performanceIntegration(options = {}) {
    return {
        name: "Performance",
        setup(config) {
            if (typeof window === "undefined")
                return;
            const metricsToObserve = options.metrics ?? DEFAULT_METRICS;
            const minRating = options.minRating ?? "needs-improvement";
            // Dynamic import keeps web-vitals (~3 KB) out of apps that don't install
            // this integration. Fire and forget — if web-vitals fails to load we
            // don't block the rest of capture.
            void (async () => {
                try {
                    const webVitals = await import("web-vitals");
                    const register = (name, fn) => {
                        if (!metricsToObserve.includes(name))
                            return;
                        fn((metric) => {
                            if (!meetsThreshold(metric.rating, minRating))
                                return;
                            const payload = {
                                name,
                                value: metric.value,
                                rating: metric.rating,
                                delta: metric.delta,
                                id: metric.id,
                                navigationType: metric.navigationType,
                            };
                            report(payload, config, options);
                        });
                    };
                    register("LCP", webVitals.onLCP);
                    register("INP", webVitals.onINP);
                    register("CLS", webVitals.onCLS);
                    register("FCP", webVitals.onFCP);
                    register("TTFB", webVitals.onTTFB);
                }
                catch (err) {
                    if (config.debug && !config.silent) {
                        console.warn("[@inariwatch/capture-performance] web-vitals failed to load:", err instanceof Error ? err.message : err);
                    }
                }
            })();
        },
    };
}
/**
 * Forward a metric to InariWatch as a structured log event. Log level
 * follows the rating so dashboards can filter:
 *   good → info, needs-improvement → warn, poor → error.
 */
function report(metric, config, options) {
    try {
        if (options.onMetric)
            options.onMetric(metric);
    }
    catch {
        // User callbacks shouldn't break metric reporting
    }
    const level = metric.rating === "good" ? "info" :
        metric.rating === "poor" ? "error" : "warn";
    const title = `vitals.${metric.name.toLowerCase()}: ${Math.round(metric.value)}${metric.name === "CLS" ? "" : "ms"}`;
    // Pathname emission — opt out or redact for apps that put sensitive tokens
    // into URL paths (magic links, password resets). Default includes the raw
    // pathname because per-route grouping is the usual reason to use this.
    const includePathname = options.includePathname !== false;
    let pathname;
    if (includePathname && typeof location !== "undefined") {
        const raw = location.pathname;
        pathname = options.redactPathname ? options.redactPathname(raw) : raw;
    }
    try {
        captureLog(title, level, {
            kind: "web_vitals",
            metric: metric.name,
            value: metric.value,
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
            pathname,
        });
    }
    catch (err) {
        if (config.debug && !config.silent) {
            console.warn("[@inariwatch/capture-performance] captureLog failed:", err instanceof Error ? err.message : err);
        }
    }
}
//# sourceMappingURL=index.js.map