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
 * Mark a Web API Request object's inputs as tainted.
 * Works with any framework that passes a Fetch-compatible Request: Next.js,
 * Remix, SvelteKit, Astro, Hono, Cloudflare Workers, Deno, Bun, etc.
 *
 * Call this in instrumentation.ts, middleware.ts, or your framework's
 * equivalent request entrypoint.
 *
 * Usage: markRequestTainted(request)
 */
export declare function markRequestTainted(request: {
    url?: string;
    headers?: {
        get?: (key: string) => string | null;
        forEach?: (fn: (v: string, k: string) => void) => void;
    };
}): void;
//# sourceMappingURL=sources.d.ts.map