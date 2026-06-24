/**
 * Scope — request context, user context, and tags.
 * Uses AsyncLocalStorage for per-request isolation in Node.js.
 * Falls back to global state in edge runtime.
 */
interface Scope {
    user?: {
        id?: string;
        role?: string;
    };
    tags?: Record<string, string>;
    requestContext?: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        query?: Record<string, string>;
        body?: unknown;
        ip?: string;
    };
}
export declare function setUser(user: {
    id?: string;
    email?: string;
    role?: string;
}): void;
export declare function setTag(key: string, value: string): void;
export declare function setRequestContext(ctx: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    ip?: string;
}): void;
export declare function getUser(): Scope["user"];
export declare function getTags(): Scope["tags"];
export declare function getRequestContext(): Scope["requestContext"];
/**
 * Run a function with an isolated scope (for per-request isolation).
 * Use in middleware: runWithScope(() => handleRequest(req, res))
 */
export declare function runWithScope<T>(fn: () => T): T;
export {};
//# sourceMappingURL=scope.d.ts.map