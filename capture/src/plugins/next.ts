/**
 * Next.js plugin — wraps your next config to enable InariWatch capture.
 *
 * Usage in next.config.ts:
 *   import { withInariWatch } from "@inariwatch/capture/next"
 *   export default withInariWatch(nextConfig)
 *
 * Config is read from env vars:
 *   INARIWATCH_DSN         — capture endpoint (omit for local mode)
 *   INARIWATCH_ENVIRONMENT — environment tag (fallback: NODE_ENV)
 *   INARIWATCH_RELEASE     — release version
 *   INARIWATCH_SUBSTRATE   — set to "true" to enable I/O recording
 */

type NextConfig = Record<string, unknown> & {
  experimental?: Record<string, unknown>
}

export function withInariWatch(nextConfig: NextConfig = {}): NextConfig {
  return {
    ...nextConfig,
    experimental: {
      ...nextConfig.experimental,
      instrumentationHook: true,
    },
  }
}
