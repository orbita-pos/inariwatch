/** Truncate a string to byte budget and mark with an ellipsis. */
function truncateString(s, budget) {
    if (s.length <= budget.remainingBytes) {
        budget.remainingBytes -= s.length;
        return { out: s, truncated: false };
    }
    const out = s.slice(0, Math.max(0, budget.remainingBytes - 1)) + "…";
    budget.remainingBytes = 0;
    return { out, truncated: true };
}
function reprPrimitive(value, budget) {
    if (value === null)
        return { repr: "null", truncated: false, kind: "null" };
    const t = typeof value;
    if (t === "undefined")
        return { repr: "undefined", truncated: false, kind: "undefined" };
    if (t === "string") {
        const { out, truncated } = truncateString(JSON.stringify(value), budget);
        return { repr: out, truncated, kind: "string" };
    }
    if (t === "number" || t === "boolean" || t === "bigint") {
        const s = t === "bigint" ? `${value.toString()}n` : String(value);
        const { out, truncated } = truncateString(s, budget);
        return { repr: out, truncated, kind: t };
    }
    if (t === "symbol") {
        const { out, truncated } = truncateString(value.toString(), budget);
        return { repr: out, truncated, kind: "symbol" };
    }
    if (t === "function") {
        const name = value.name || "<anonymous>";
        const { out, truncated } = truncateString(`[Function: ${name}]`, budget);
        return { repr: out, truncated, kind: "function" };
    }
    return { repr: "", truncated: false, kind: "unknown" };
}
function reprObject(value, depth, budget, seen) {
    if (seen.has(value)) {
        const { out, truncated } = truncateString("[Circular]", budget);
        return { repr: out, truncated, kind: "object" };
    }
    seen.add(value);
    if (value instanceof Error) {
        const { out, truncated } = truncateString(`${value.name}: ${value.message}`, budget);
        return { repr: out, truncated, kind: "error" };
    }
    if (value instanceof Date) {
        const { out, truncated } = truncateString(value.toISOString(), budget);
        return { repr: out, truncated, kind: "object:Date" };
    }
    if (value instanceof RegExp) {
        const { out, truncated } = truncateString(value.toString(), budget);
        return { repr: out, truncated, kind: "object:RegExp" };
    }
    if (typeof value.then === "function") {
        const { out, truncated } = truncateString("[Promise]", budget);
        return { repr: out, truncated, kind: "promise" };
    }
    if (depth >= budget.maxDepth) {
        const ctor = (value.constructor && value.constructor.name) || "Object";
        const { out, truncated } = truncateString(`[${ctor}]`, budget);
        return { repr: out, truncated: true, kind: `object:${ctor}` };
    }
    if (Array.isArray(value)) {
        const parts = [];
        let truncated = false;
        for (let i = 0; i < value.length; i++) {
            if (budget.remainingBytes <= 3) {
                truncated = true;
                break;
            }
            const child = reprAny(value[i], depth + 1, budget, seen);
            parts.push(child.repr);
            if (child.truncated)
                truncated = true;
        }
        const body = parts.join(",");
        return { repr: `[${body}${truncated ? ",…" : ""}]`, truncated, kind: "array" };
    }
    const ctor = (value.constructor && value.constructor.name) || "Object";
    const entries = [];
    let truncated = false;
    const keys = Object.keys(value);
    for (const key of keys) {
        if (budget.remainingBytes <= 3) {
            truncated = true;
            break;
        }
        const keyJson = JSON.stringify(key);
        const child = reprAny(value[key], depth + 1, budget, seen);
        entries.push(`${keyJson}:${child.repr}`);
        if (child.truncated)
            truncated = true;
    }
    const body = entries.join(",");
    return { repr: `{${body}${truncated ? ",…" : ""}}`, truncated, kind: `object:${ctor}` };
}
function reprAny(value, depth, budget, seen) {
    if (value === null || typeof value !== "object") {
        return reprPrimitive(value, budget);
    }
    return reprObject(value, depth, budget, seen);
}
export function serializeValue(name, value, opts) {
    const budget = { remainingBytes: opts.maxValueBytes, maxDepth: opts.maxValueDepth };
    const seen = new WeakSet();
    const { repr, truncated, kind } = reprAny(value, 0, budget, seen);
    const out = { name, repr, kind };
    if (truncated)
        out.truncated = true;
    return out;
}
//# sourceMappingURL=serialize.js.map