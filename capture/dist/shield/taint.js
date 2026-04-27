/**
 * Taint tracking — marks user inputs as "tainted" and checks if they
 * reach dangerous sinks (database queries, shell commands, file ops).
 *
 * Uses a per-request Map<string, TaintSource> to track tainted strings.
 * Cleared after each request to prevent memory leaks.
 */
// Per-request taint store using AsyncLocalStorage
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asyncStorage = null;
try {
    const { AsyncLocalStorage } = globalThis.require("node:async_hooks");
    asyncStorage = new AsyncLocalStorage();
}
catch {
    // Edge runtime — fallback to global store
}
// Global fallback for environments without AsyncLocalStorage
let globalStore = null;
const MAX_TAINT_ENTRIES = 500; // Prevent unbounded memory growth
function getStore() {
    if (asyncStorage) {
        const store = asyncStorage.getStore();
        if (store)
            return store;
    }
    if (!globalStore)
        globalStore = new Map();
    // Evict oldest entries if store exceeds limit (prevents memory leak)
    if (globalStore.size > MAX_TAINT_ENTRIES) {
        const toDelete = globalStore.size - MAX_TAINT_ENTRIES;
        const keys = globalStore.keys();
        for (let i = 0; i < toDelete; i++) {
            const next = keys.next();
            if (!next.done)
                globalStore.delete(next.value);
        }
    }
    return globalStore;
}
/** Mark a string as tainted (came from user input). */
export function markTainted(input, source) {
    if (typeof input !== "string" || input.length < 2)
        return;
    const store = getStore();
    store.set(input, { label: source, value: input.slice(0, 200) });
}
/** Mark all values in an object as tainted (e.g. req.query, req.body). */
export function markObjectTainted(obj, prefix) {
    if (!obj || typeof obj !== "object")
        return;
    for (const [key, value] of Object.entries(obj)) {
        const label = `${prefix}.${key}`;
        if (typeof value === "string") {
            markTainted(value, label);
        }
        else if (typeof value === "object" && value !== null) {
            // Recurse one level for nested objects (e.g. req.body.address.city)
            for (const [k2, v2] of Object.entries(value)) {
                if (typeof v2 === "string") {
                    markTainted(v2, `${label}.${k2}`);
                }
            }
        }
    }
}
/** Check if a string argument contains any tainted input. */
export function checkTaint(sinkArg, minLength = 3) {
    if (typeof sinkArg !== "string")
        return null;
    const store = getStore();
    for (const [tainted, source] of store) {
        if (tainted.length >= minLength && sinkArg.includes(tainted)) {
            return { tainted, source };
        }
    }
    return null;
}
/** Run a function with a fresh per-request taint store. */
export function runWithTaintStore(fn) {
    if (asyncStorage) {
        return asyncStorage.run(new Map(), fn);
    }
    // Fallback: clear global store
    globalStore = new Map();
    try {
        return fn();
    }
    finally {
        globalStore = null;
    }
}
/** Clear current taint store (call at end of request). */
export function clearTaint() {
    const store = getStore();
    store.clear();
}
//# sourceMappingURL=taint.js.map