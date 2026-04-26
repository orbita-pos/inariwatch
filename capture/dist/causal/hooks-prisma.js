/**
 * Prisma driver hook — patches `PrismaClient.prototype._request` to record
 * a causal-graph node for every model call.
 *
 * `_request` is the private internal method that all proxy methods
 * (`prisma.user.findMany()`, `prisma.$transaction(...)`, …) route through
 * in v4-v6. It's not in the public API, so we guard with a typeof check
 * and silently skip if it's missing or renamed in a future major.
 *
 * For users who can't rely on prototype patches (extended clients,
 * Edge runtime, custom engine), the `instrumentPrismaClient(client)`
 * helper installs the same node-recording listener via `$on('query')`
 * — this requires the client to be constructed with `log: ['query']`.
 *
 * Driver missing: install resolves to `false` silently. Never throws.
 */
import { recordOp } from "./graph.js";
import { findDataFromIds } from "./data-flow.js";
const PATCH_MARK = Symbol.for("@inariwatch/capture.causal.prisma.patched");
const DEFAULT_LOADER = () => {
    // Indirect via a variable so TypeScript doesn't try to resolve the
    // module at compile time — `@prisma/client` is an optional peer.
    const pkg = "@prisma/client";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import(/* webpackIgnore: true */ pkg);
};
/**
 * Patch `@prisma/client`'s `PrismaClient.prototype._request`. Returns
 * `true` if newly patched, `false` if missing or already patched.
 */
export async function installPrismaHook(loader = DEFAULT_LOADER) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prismaMod;
    try {
        prismaMod = await loader();
    }
    catch {
        return false;
    }
    const mod = prismaMod?.default ?? prismaMod;
    if (!mod?.PrismaClient?.prototype)
        return false;
    return patchPrismaPrototype(mod.PrismaClient.prototype);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchPrismaPrototype(proto) {
    if (proto[PATCH_MARK])
        return false;
    const original = proto._request;
    if (typeof original !== "function")
        return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proto._request = function patchedRequest(...args) {
        const params = args[0];
        const op = `prisma.${params?.modelName ?? "raw"}.${params?.action ?? "request"}`;
        const handle = recordOp(op, {
            args: truncate(safeJson(params?.args), 300),
        });
        const start = Date.now();
        // Data-flow stitch: prisma calls take a single args object whose
        // `where` / `data` fields commonly hold values that came from an
        // earlier HTTP response. Walk both the wrapper and `params.args`
        // (one level into `where`) so `prisma.user.findUnique({ where: { id }})`
        // gets matched against the http response root that produced `id`.
        const dataFrom = findDataFromIds([params, params?.args]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result;
        try {
            result = original.apply(this, args);
        }
        catch (err) {
            handle.end({ durationMs: Date.now() - start, error: err, dataFrom });
            throw err;
        }
        if (result && typeof result.then === "function") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return result.then(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (v) => {
                handle.end({ durationMs: Date.now() - start, dataFrom });
                return v;
            }, 
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (err) => {
                handle.end({ durationMs: Date.now() - start, error: err, dataFrom });
                throw err;
            });
        }
        handle.end({ durationMs: Date.now() - start, dataFrom });
        return result;
    };
    Object.defineProperty(proto, PATCH_MARK, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
    });
    return true;
}
/**
 * Manual instrumentation hook. Usage:
 *
 *   const prisma = new PrismaClient({ log: [{ level: "query", emit: "event" }] })
 *   instrumentPrismaClient(prisma)
 *
 * Adds a `$on('query')` listener that records each query as a graph node.
 * Returns `true` on success, `false` if the client refused (missing
 * `$on`, log not configured, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function instrumentPrismaClient(client) {
    if (!client || client[PATCH_MARK])
        return false;
    if (typeof client.$on !== "function")
        return false;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.$on("query", (e) => {
            const handle = recordOp("prisma.query", {
                sql: truncate(typeof e?.query === "string" ? e.query : "", 500),
                params: truncate(typeof e?.params === "string" ? e.params : "", 200),
                target: e?.target,
            });
            const dur = typeof e?.duration === "number" ? e.duration : undefined;
            handle.end({ durationMs: dur });
        });
        Object.defineProperty(client, PATCH_MARK, {
            value: true,
            configurable: true,
            enumerable: false,
            writable: false,
        });
        return true;
    }
    catch {
        return false;
    }
}
function safeJson(v) {
    if (v === undefined)
        return "";
    try {
        return JSON.stringify(v);
    }
    catch {
        return "<unserializable>";
    }
}
function truncate(s, n) {
    if (s.length <= n)
        return s;
    return s.slice(0, n) + "…";
}
// ─── Test helpers ──────────────────────────────────────────────────────────
export const __PRISMA_PATCH_MARK_FOR_TESTING = PATCH_MARK;
//# sourceMappingURL=hooks-prisma.js.map