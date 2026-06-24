/** Short CSS selector for an element — best-effort, not guaranteed unique. */
export function elSelector(el) {
    if (el.id)
        return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).slice(0, 2).map(c => `.${c}`).join("");
    return `${tag}${classes}`;
}
/** Apply optional pathname redaction from AwakeConfig. */
export function getPathname(config) {
    if (typeof window === "undefined")
        return undefined;
    const raw = location.pathname;
    const r = config.redactPathname;
    if (!r)
        return raw;
    if (typeof r === "function")
        return r(raw);
    return "[redacted]";
}
/** Schedule work during browser idle time (with a 5-second deadline). */
export function onIdle(cb) {
    if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(cb, { timeout: 5000 });
    }
    else {
        setTimeout(cb, 1000);
    }
}
export function ratingForMs(ms, goodThreshold, poorThreshold) {
    if (ms < goodThreshold)
        return "good";
    if (ms < poorThreshold)
        return "needs-improvement";
    return "poor";
}
export function levelForRating(rating) {
    if (rating === "good")
        return "info";
    if (rating === "needs-improvement")
        return "warn";
    return "error";
}
export function meetsMinRating(rating, min) {
    const order = { good: 0, "needs-improvement": 1, poor: 2 };
    return order[rating] >= order[min];
}
//# sourceMappingURL=utils.js.map