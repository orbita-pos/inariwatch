import { captureLog } from "../client.js";
import { getPathname, meetsMinRating } from "./utils.js";
let installed = false;
export function installWebVitals(config) {
    if (typeof window === "undefined")
        return;
    if (installed)
        return;
    installed = true;
    const minRating = config.minRating ?? "needs-improvement";
    const pathname = getPathname(config);
    void (async () => {
        try {
            const wv = await import("web-vitals/attribution");
            wv.onLCP((metric) => {
                if (!meetsMinRating(metric.rating, minRating))
                    return;
                captureLog(`vitals.lcp: ${Math.round(metric.value)}ms`, metric.rating === "poor" ? "error" : "warn", {
                    kind: "web_vital",
                    metric: "LCP",
                    valueMs: Math.round(metric.value),
                    rating: metric.rating,
                    delta: metric.delta,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    pathname,
                    attribution: {
                        element: metric.attribution.element,
                        url: metric.attribution.url,
                        timeToFirstByteMs: metric.attribution.timeToFirstByte,
                        resourceLoadDurationMs: metric.attribution.resourceLoadDuration,
                        elementRenderDelayMs: metric.attribution.elementRenderDelay,
                    },
                });
            });
            wv.onINP((metric) => {
                if (!meetsMinRating(metric.rating, minRating))
                    return;
                captureLog(`vitals.inp: ${Math.round(metric.value)}ms`, metric.rating === "poor" ? "error" : "warn", {
                    kind: "web_vital",
                    metric: "INP",
                    valueMs: Math.round(metric.value),
                    rating: metric.rating,
                    delta: metric.delta,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    pathname,
                    attribution: {
                        interactionTarget: metric.attribution.interactionTarget,
                        interactionType: metric.attribution.interactionType,
                        inputDelayMs: metric.attribution.inputDelay,
                        processingDurationMs: metric.attribution.processingDuration,
                        presentationDelayMs: metric.attribution.presentationDelay,
                    },
                });
            });
            wv.onCLS((metric) => {
                if (!meetsMinRating(metric.rating, minRating))
                    return;
                captureLog(`vitals.cls: ${metric.value.toFixed(3)}`, metric.rating === "poor" ? "error" : "warn", {
                    kind: "web_vital",
                    metric: "CLS",
                    value: metric.value,
                    rating: metric.rating,
                    delta: metric.delta,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    pathname,
                    attribution: {
                        largestShiftTarget: metric.attribution.largestShiftTarget,
                        largestShiftValue: metric.attribution.largestShiftValue,
                        loadState: metric.attribution.loadState,
                    },
                });
            });
            wv.onTTFB((metric) => {
                if (!meetsMinRating(metric.rating, minRating))
                    return;
                captureLog(`vitals.ttfb: ${Math.round(metric.value)}ms`, metric.rating === "poor" ? "error" : "warn", {
                    kind: "web_vital",
                    metric: "TTFB",
                    valueMs: Math.round(metric.value),
                    rating: metric.rating,
                    delta: metric.delta,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    pathname,
                    attribution: {
                        waitingDurationMs: metric.attribution.waitingDuration,
                        dnsDurationMs: metric.attribution.dnsDuration,
                        connectionDurationMs: metric.attribution.connectionDuration,
                        requestDurationMs: metric.attribution.requestDuration,
                    },
                });
            });
            wv.onFCP((metric) => {
                if (!meetsMinRating(metric.rating, minRating))
                    return;
                captureLog(`vitals.fcp: ${Math.round(metric.value)}ms`, metric.rating === "poor" ? "error" : "warn", {
                    kind: "web_vital",
                    metric: "FCP",
                    valueMs: Math.round(metric.value),
                    rating: metric.rating,
                    delta: metric.delta,
                    id: metric.id,
                    navigationType: metric.navigationType,
                    pathname,
                });
            });
        }
        catch {
            // web-vitals not installed — skip silently. Install with: npm i web-vitals
        }
    })();
}
//# sourceMappingURL=web-vitals.js.map