/**
 * Drop-in replacement for Sentry.captureRequestError.
 *
 * Usage in instrumentation.ts:
 *   import { captureRequestError } from "@inariwatch/capture"
 *   export { captureRequestError as onRequestError }
 */
export declare const captureRequestError: (err: {
    digest: string;
} & Error, request: {
    path: string;
    method: string;
    headers: Record<string, string>;
}, context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "page" | "route" | "middleware";
}) => Promise<void>;
//# sourceMappingURL=nextjs.d.ts.map