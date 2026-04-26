/**
 * Intent contracts compiler — common types (SKYNET §3 piece 5, Track D).
 *
 * Goal: when an error throws, the AI knows what *actually* arrived
 * (`evidence.request.body`, locals, …). It does NOT know what the code
 * *expected*. The intent compiler closes that gap by extracting the
 * declared shape of the request param / validator / DTO from the user's
 * source and attaching it as `evidence.response_expected_schema`.
 *
 * 8 sources are planned (TS, Zod, OpenAPI, Drizzle, Prisma, GraphQL,
 * Pydantic, Java records, Rust serde). Part 1 ships TS + Zod — the two
 * shapes the JS ecosystem actually uses.
 *
 * Each source implements `IntentSource`. The compiler walks every source
 * registered, asks `canParse(file)`, then `extract(file, symbol)`. The
 * resolver picks the file from the failing stack frame and asks each
 * source what symbol is closest to that frame.
 *
 * IntentShape is a JSON-Schema-ish dialect. We intentionally don't import
 * the official JSON Schema types — different sources produce different
 * subsets, and locking to the spec would force conversions everyone
 * downstream has to undo. The shape is opaque to the wire payload anyway
 * (the LLM reads it as JSON).
 */
/** Hard cap on serialized shape size — anything past this is truncated. */
export const MAX_SHAPE_BYTES = 10 * 1024;
/**
 * Truncate a shape so its serialized JSON fits in MAX_SHAPE_BYTES. We
 * truncate by replacing nested object/array bodies with `{ _truncated: true }`
 * starting from the deepest leaves. The top-level type/symbol stays so the
 * LLM still gets *something*.
 */
export function capShapeSize(shape) {
    const json = safeStringify(shape);
    if (json.length <= MAX_SHAPE_BYTES)
        return shape;
    // Try progressively more aggressive truncation passes.
    for (let depth = 4; depth >= 1; depth--) {
        const candidate = truncateAtDepth(shape, depth);
        if (safeStringify(candidate).length <= MAX_SHAPE_BYTES)
            return candidate;
    }
    // Last resort: just keep the top-level descriptor.
    return {
        type: shape.type ?? "object",
        _symbol: shape._symbol,
        _truncated: true,
    };
}
function truncateAtDepth(s, depth) {
    if (depth <= 0) {
        return { type: s.type, _truncated: true, ...(s._symbol ? { _symbol: s._symbol } : {}) };
    }
    const out = { ...s };
    if (s.properties) {
        out.properties = {};
        for (const [k, v] of Object.entries(s.properties)) {
            out.properties[k] = truncateAtDepth(v, depth - 1);
        }
    }
    if (s.items) {
        out.items = truncateAtDepth(s.items, depth - 1);
    }
    return out;
}
function safeStringify(v) {
    try {
        return JSON.stringify(v) ?? "";
    }
    catch {
        return "";
    }
}
//# sourceMappingURL=types.js.map