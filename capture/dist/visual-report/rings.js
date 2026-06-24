/**
 * Console + network ring buffers for visual reports.
 *
 * Installed at SDK boot (via `visualReportIntegration.setup`) so that by the
 * time a user clicks "Report bug" the rings already hold the recent context
 * needed for AI diagnosis. Both are bounded — old entries fall off the back
 * to keep memory + payload constant.
 *
 * Privacy:
 *   - Console: arguments are JSON-stringified with a safe serializer that
 *     drops functions, DOM nodes, and oversized values. PII redaction is
 *     done server-side via the existing `lib/redact/` patterns at submit
 *     time — keeping it here would double the work on every console.* call.
 *   - Network: only the URL + status + timing are captured by default.
 *     Bodies are NOT captured (large + privacy risk). The PerformanceObserver
 *     path is sufficient for "what requests fired recently".
 */
const CONSOLE_RING_CAP = 50;
const consoleRing = [];
let consoleInstalled = false;
export function installConsoleRing() {
    if (consoleInstalled)
        return;
    if (typeof console === "undefined")
        return;
    consoleInstalled = true;
    ["log", "info", "warn", "error", "debug"].forEach((level) => {
        const orig = console[level];
        if (typeof orig !== "function")
            return;
        console[level] = (...args) => {
            try {
                const stack = new Error().stack ?? "";
                const lines = stack.split("\n");
                const site = lines[2]?.trim() ?? null;
                consoleRing.push({ level, ts: Date.now(), args: args.map((a) => safeSerialize(a)), site });
                if (consoleRing.length > CONSOLE_RING_CAP)
                    consoleRing.shift();
            }
            catch {
                // Never let our instrumentation break user logging.
            }
            return orig.apply(console, args);
        };
    });
}
export function readConsoleRing() {
    return consoleRing.slice();
}
const NETWORK_RING_CAP = 20;
const networkRing = [];
let networkInstalled = false;
export function installNetworkRing() {
    if (networkInstalled)
        return;
    if (typeof window === "undefined")
        return;
    networkInstalled = true;
    // PerformanceObserver — gives us EVERY resource fetch (incl. images, CSS,
    // CORS-opaque calls). Zero perf overhead because the browser already
    // tracks these. No body access.
    try {
        if (typeof PerformanceObserver === "function") {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const e = entry;
                    push({
                        url: e.name,
                        method: "GET", // PerformanceObserver doesn't expose method
                        status: null,
                        ts: Math.round(Date.now() - performance.now() + e.startTime),
                        durMs: Math.round(e.duration),
                        size: typeof e.transferSize === "number" ? e.transferSize : null,
                        source: "performance",
                    });
                }
            }).observe({ type: "resource", buffered: true });
        }
    }
    catch {
        // Old browser — skip.
    }
    // Patch fetch — captures method + status which PerformanceObserver doesn't.
    // Body is intentionally NOT captured for size + privacy reasons.
    if (typeof window.fetch === "function") {
        const origFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const start = Date.now();
            const url = typeof input === "string" ? input : input.url;
            const reqMethod = typeof input !== "string" ? input.method : undefined;
            const method = (init?.method ?? reqMethod ?? "GET").toUpperCase();
            try {
                const res = await origFetch(input, init);
                push({
                    url,
                    method,
                    status: res.status,
                    ts: start,
                    durMs: Date.now() - start,
                    size: null,
                    source: "fetch",
                });
                return res;
            }
            catch (err) {
                push({
                    url,
                    method,
                    status: 0,
                    ts: start,
                    durMs: Date.now() - start,
                    size: null,
                    source: "fetch",
                });
                throw err;
            }
        };
    }
    // Patch XHR — same telemetry as fetch.
    if (typeof window.XMLHttpRequest === "function") {
        const proto = window.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function patchedOpen(method, url, ...rest) {
            this.__iwUrl = String(url);
            this.__iwMethod = method.toUpperCase();
            // The original `open` accepts a variadic tail (async, user, password) —
            // forward them through unchanged.
            return origOpen.apply(this, [method, url, ...rest]);
        };
        proto.send = function patchedSend(body) {
            const start = Date.now();
            const onDone = () => {
                push({
                    url: this.__iwUrl ?? "",
                    method: this.__iwMethod ?? "GET",
                    status: this.status,
                    ts: start,
                    durMs: Date.now() - start,
                    size: null,
                    source: "xhr",
                });
            };
            this.addEventListener("loadend", onDone, { once: true });
            return origSend.call(this, body ?? null);
        };
    }
    function push(entry) {
        networkRing.push(entry);
        if (networkRing.length > NETWORK_RING_CAP)
            networkRing.shift();
    }
}
export function readNetworkRing() {
    return networkRing.slice();
}
// ── Safe serializer (bounded depth + length) ─────────────────────────────────
function safeSerialize(v, depth = 2, maxStr = 512) {
    if (depth < 0)
        return "[truncated]";
    if (v === null || v === undefined)
        return v;
    const t = typeof v;
    if (t === "number" || t === "boolean")
        return v;
    if (t === "string")
        return v.slice(0, maxStr);
    if (t === "function")
        return "[function]";
    if (v instanceof Error)
        return { name: v.name, message: v.message, stack: v.stack?.slice(0, 2048) };
    if (typeof Node !== "undefined" && v instanceof Node)
        return `[${v.nodeName}]`;
    if (Array.isArray(v))
        return v.slice(0, 20).map((x) => safeSerialize(x, depth - 1, maxStr));
    if (t === "object") {
        const out = {};
        const keys = Object.keys(v).slice(0, 30);
        for (const k of keys) {
            try {
                out[k] = safeSerialize(v[k], depth - 1, maxStr);
            }
            catch {
                out[k] = "[unserializable]";
            }
        }
        return out;
    }
    return String(v).slice(0, maxStr);
}
//# sourceMappingURL=rings.js.map