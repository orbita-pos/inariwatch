import { captureException } from "../client.js";
/**
 * Drop-in replacement for Sentry.captureRequestError.
 *
 * Usage in instrumentation.ts:
 *   import { captureRequestError } from "@inariwatch/capture"
 *   export { captureRequestError as onRequestError }
 */
export const captureRequestError = async (err, request, context) => {
    captureException(err, {
        request: { method: request.method, url: request.path },
        runtime: "nodejs",
        routePath: context.routePath,
        routeType: context.routeType,
    });
};
//# sourceMappingURL=nextjs.js.map