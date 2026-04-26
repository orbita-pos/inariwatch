import type { Breadcrumb, RequestContext } from "./types.js";
interface ScopeData {
    user?: {
        id: string;
        role?: string;
    };
    tags: Record<string, string>;
    request?: RequestContext;
    breadcrumbs: Breadcrumb[];
}
export declare function setUser(id: string, role?: string): void;
export declare function getUser(): ScopeData["user"];
export declare function setTag(key: string, value: string): void;
export declare function getTags(): Record<string, string>;
export declare function setRequestContext(req: RequestContext): void;
export declare function getRequestContext(): RequestContext | undefined;
export declare function addBreadcrumb(crumb: Omit<Breadcrumb, "timestamp"> & {
    timestamp?: string;
}): void;
export declare function getBreadcrumbs(): Breadcrumb[];
export declare function clearBreadcrumbs(): void;
export declare function clearScope(): void;
export declare function withScope<T>(fn: () => T): T;
export declare function shouldRedactHeader(name: string): boolean;
export declare function scrubSecrets(text: string): string;
export declare function scrubUrl(url: string): string;
export declare function redactBody(body: unknown): unknown;
export {};
//# sourceMappingURL=scope.d.ts.map