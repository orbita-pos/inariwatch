/**
 * Source hooks — mark user inputs as tainted when they enter the application.
 *
 * Provides middleware for Express/Fastify/Hono and a function for Next.js.
 */
import { markTainted, markObjectTainted, runWithTaintStore } from "./taint.js";
/**
 * Express/Connect-style middleware — marks req.query, req.params, req.body,
 * req.headers, req.cookies as tainted for the duration of the request.
 *
 * Usage: app.use(shieldMiddleware())
 */
export function shieldMiddleware() {
    return (req, _res, next) => {
        runWithTaintStore(() => {
            // Mark all user-controlled inputs
            if (req.query)
                markObjectTainted(req.query, "req.query");
            if (req.params)
                markObjectTainted(req.params, "req.params");
            if (req.body)
                markObjectTainted(req.body, "req.body");
            if (req.cookies)
                markObjectTainted(req.cookies, "req.cookies");
            // Mark specific dangerous headers (not all — too noisy)
            const headers = req.headers;
            if (headers) {
                for (const key of ["x-forwarded-for", "x-forwarded-host", "referer", "origin"]) {
                    if (headers[key])
                        markTainted(headers[key], `req.headers.${key}`);
                }
            }
            // Mark URL path segments
            const url = req.url;
            if (url) {
                const pathSegments = url.split("?")[0].split("/").filter(Boolean);
                for (const seg of pathSegments) {
                    if (seg.length >= 3)
                        markTainted(decodeURIComponent(seg), "req.url.path");
                }
                // Mark raw query string values (in case req.query isn't parsed yet)
                const qs = url.split("?")[1];
                if (qs) {
                    for (const pair of qs.split("&")) {
                        const [, val] = pair.split("=");
                        if (val && val.length >= 3) {
                            markTainted(decodeURIComponent(val), "req.url.query");
                        }
                    }
                }
            }
            next();
        });
    };
}
/**
 * Mark a Next.js/Web API Request object's inputs as tainted.
 * Call this in instrumentation.ts or middleware.ts.
 *
 * Usage: markRequestTainted(request)
 */
export function markRequestTainted(request) {
    // URL search params
    if (request.nextUrl?.searchParams) {
        request.nextUrl.searchParams.forEach((value, key) => {
            markTainted(value, `req.searchParams.${key}`);
        });
    }
    else if (request.url) {
        try {
            const url = new URL(request.url);
            url.searchParams.forEach((value, key) => {
                markTainted(value, `req.searchParams.${key}`);
            });
        }
        catch { /* invalid URL */ }
    }
    // Dangerous headers
    if (request.headers?.get) {
        for (const key of ["x-forwarded-for", "x-forwarded-host", "referer", "origin"]) {
            const val = request.headers.get(key);
            if (val)
                markTainted(val, `req.headers.${key}`);
        }
    }
    // URL path segments
    if (request.url) {
        try {
            const path = new URL(request.url).pathname;
            for (const seg of path.split("/").filter(Boolean)) {
                if (seg.length >= 3)
                    markTainted(decodeURIComponent(seg), "req.url.path");
            }
        }
        catch { /* invalid URL */ }
    }
}
//# sourceMappingURL=sources.js.map