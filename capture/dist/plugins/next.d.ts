/**
 * Next.js plugin — wraps your next config to enable InariWatch capture.
 * Automatically injects git context at build time as env vars.
 *
 * Usage in next.config.ts:
 *   import { withInariWatch } from "@inariwatch/capture/next"
 *   export default withInariWatch(nextConfig)
 */
type NextConfig = Record<string, unknown> & {
    experimental?: Record<string, unknown>;
    env?: Record<string, string>;
};
export declare function withInariWatch(nextConfig?: NextConfig): NextConfig;
export {};
//# sourceMappingURL=next.d.ts.map