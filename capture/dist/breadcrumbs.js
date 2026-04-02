/**
 * Breadcrumbs — automatic trail of actions before a crash.
 * Ring buffer of last 30 events: console, fetch, custom.
 */
const MAX_BREADCRUMBS = 30;
const breadcrumbs = [];
let initialized = false;
export function addBreadcrumb(crumb) {
    breadcrumbs.push({
        timestamp: new Date().toISOString(),
        category: crumb.category ?? "custom",
        level: crumb.level ?? "info",
        message: crumb.message.slice(0, 200),
        data: crumb.data,
    });
    if (breadcrumbs.length > MAX_BREADCRUMBS)
        breadcrumbs.shift();
}
export function getBreadcrumbs() {
    return [...breadcrumbs];
}
/**
 * Auto-intercept console and fetch to record breadcrumbs.
 * Called once from init(). Safe to call multiple times (idempotent).
 */
export function initBreadcrumbs() {
    if (initialized)
        return;
    initialized = true;
    // Intercept console.log/warn/error
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args) => {
        addBreadcrumb({ category: "console", message: formatArgs(args), level: "info" });
        origLog.apply(console, args);
    };
    console.warn = (...args) => {
        addBreadcrumb({ category: "console", message: formatArgs(args), level: "warning" });
        origWarn.apply(console, args);
    };
    console.error = (...args) => {
        addBreadcrumb({ category: "console", message: formatArgs(args), level: "error" });
        origError.apply(console, args);
    };
    // Intercept fetch
    if (typeof globalThis.fetch === "function") {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const method = init?.method ?? "GET";
            addBreadcrumb({ category: "fetch", message: `${method} ${url}`, level: "info" });
            try {
                const resp = await origFetch(input, init);
                if (!resp.ok) {
                    addBreadcrumb({ category: "fetch", message: `${method} ${url} → ${resp.status}`, level: "warning" });
                }
                return resp;
            }
            catch (err) {
                addBreadcrumb({ category: "fetch", message: `${method} ${url} → FAILED`, level: "error" });
                throw err;
            }
        };
    }
}
function formatArgs(args) {
    return args.map((a) => {
        if (typeof a === "string")
            return a;
        try {
            return JSON.stringify(a);
        }
        catch {
            return String(a);
        }
    }).join(" ").slice(0, 200);
}
//# sourceMappingURL=breadcrumbs.js.map