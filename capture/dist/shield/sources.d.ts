/**
 * Source hooks — mark user inputs as tainted when they enter the application.
 *
 * Provides middleware for Express/Fastify/Hono and a function for Next.js.
 */
/**
 * Express/Connect-style middleware — marks req.query, req.params, req.body,
 * req.headers, req.cookies as tainted for the duration of the request.
 *
 * Usage: app.use(shieldMiddleware())
 */
export declare function shieldMiddleware(): (req: Record<string, unknown>, _res: unknown, next: () => void) => void;
/**
 * Mark a Next.js/Web API Request object's inputs as tainted.
 * Call this in instrumentation.ts or middleware.ts.
 *
 * Usage: markRequestTainted(request)
 */
export declare function markRequestTainted(request: {
    url?: string;
    nextUrl?: {
        searchParams?: URLSearchParams;
    };
    headers?: {
        get?: (key: string) => string | null;
        forEach?: (fn: (v: string, k: string) => void) => void;
    };
}): void;
//# sourceMappingURL=sources.d.ts.map