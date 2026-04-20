import type { NextConfig } from "next";
// withInariWatch wrapper intentionally NOT imported here — the published
// @inariwatch/capture@0.9.0's `./next` subpath exports only `import`/`default`
// conditions, no `require`. Next.js's config transpiler compiles this file
// to CJS and `require`s the plugin, which fails on ESM-only subpaths under
// Node 20. Dogfood capture continues to work via `instrumentation.ts` at
// runtime, which uses native ESM import. Re-add the wrapper once the
// capture package publishes with a `require` condition (next patch release).

// Security headers applied uniformly via next.config.ts.
// Per-request CSP (with strict-dynamic + nonce), COOP, CORP, and the
// X-XSS-Protection=0 override are injected by `web/middleware.ts`; those
// are intentionally NOT duplicated here to avoid double-header issues.
const securityHeaders = [
  { key: "X-Content-Type-Options",  value: "nosniff" },
  { key: "X-Frame-Options",         value: "DENY" },
  { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
  // Broadened from the original 3-feature list so modern privacy
  // features are locked down even when the browser adds new ones.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()", "autoplay=()", "camera=()",
      "cross-origin-isolated=()", "display-capture=()",
      "encrypted-media=()", "fullscreen=(self)", "geolocation=()",
      "gyroscope=()", "hid=()", "identity-credentials-get=()",
      "idle-detection=()", "magnetometer=()", "microphone=()",
      "midi=()", "otp-credentials=()", "payment=()",
      "picture-in-picture=()", "publickey-credentials-create=(self)",
      "publickey-credentials-get=(self)", "screen-wake-lock=()",
      "serial=()", "storage-access=()", "usb=()", "web-share=()",
      "xr-spatial-tracking=()", "interest-cohort=()",
      "browsing-topics=()",
    ].join(", "),
  },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const config: NextConfig = {
  // Standalone output keeps the production image tiny (~80MB vs ~400MB) by
  // tracing only the dependencies the built bundle actually imports. Required
  // for the Hetzner Docker build. No effect on Vercel — Vercel uses its own
  // tracer — so it's safe to enable now and have both surfaces work.
  output: "standalone",

  // Image optimizer — tuned for self-hosted on a single CX21.
  //
  // Vercel's edge implicitly cached `/_next/image?...` for ~1 year per PoP and
  // the origin sharp step was never the user-visible bottleneck. On the
  // Hetzner cutover, CF's default Cache Rules skip `/_next/image*` (query
  // string → marked DYNAMIC), so every user hits this origin. The 60s default
  // TTL then causes sharp to re-process large inputs on every cold miss,
  // producing 5+ second TTFB on auth-page backgrounds.
  //
  // A long minimumCacheTTL combined with a CF Cache Rule for `/_next/image*`
  // (Edge TTL 30 days, configured in the CF dashboard) restores Vercel-like
  // behavior: first user per variant per region warms both caches, the rest
  // stream from CF edge.
  //
  // formats: AVIF first (40-50% smaller than WebP) with WebP fallback.
  // deviceSizes: trimmed from the default 8-entry list to 4. A login
  // background does not need 2560/3840 variants — the source assets are
  // already capped at 1920.
  images: {
    minimumCacheTTL: 2_592_000,             // 30 days
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 828, 1200, 1920],
  },

  async headers() {
    // Order matters in headers() config — Next.js applies them top-down.
    // Security headers go first (apply to everything), then per-path
    // Cache-Control overrides. Where a path matches both rules, the per-path
    // value wins for that specific key.
    //
    // R1 fix (VERCEL_LEVEL_AUDIT_REPORT.md): Next.js emits
    // `Cache-Control: s-maxage=31536000` by default on prerendered static
    // pages. On the `app.*` subdomain this is a latent landmine — the moment
    // a Cloudflare "Cache Everything" rule is enabled, authenticated HTML
    // would be cached publicly for a year. The per-path values below cap
    // shared-cache TTL at 1 day for anonymous auth pages and explicitly
    // mark every authenticated surface as `private, no-store`.
    const authPagesCC = "public, max-age=0, s-maxage=86400, stale-while-revalidate=604800";
    const privateCC   = "private, no-store, must-revalidate";

    return [
      { source: "/:path*", headers: securityHeaders },

      // Anonymous auth pages: safe to share-cache, but ceiling at 1 day.
      { source: "/login",           headers: [{ key: "Cache-Control", value: authPagesCC }] },
      { source: "/register",        headers: [{ key: "Cache-Control", value: authPagesCC }] },
      { source: "/forgot-password", headers: [{ key: "Cache-Control", value: authPagesCC }] },
      { source: "/reset-password",  headers: [{ key: "Cache-Control", value: authPagesCC }] },
      { source: "/signout",         headers: [{ key: "Cache-Control", value: privateCC   }] },

      // Authenticated surfaces: never share-cache. Defence-in-depth even
      // though CF Cache Rules bypass these paths (see audit report A3).
      { source: "/dashboard/:path*",    headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/alerts/:path*",       headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/projects/:path*",     headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/settings/:path*",     headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/admin/:path*",        headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/integrations/:path*", headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/chat/:path*",         headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/recordings/:path*",   headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/sessions/:path*",     headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/on-call/:path*",      headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/analytics/:path*",    headers: [{ key: "Cache-Control", value: privateCC }] },
      { source: "/workspace/:path*",    headers: [{ key: "Cache-Control", value: privateCC }] },

      // All API routes: never share-cache. Individual routes that want
      // specific caching (e.g. static install script) can set their own.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: privateCC }] },
    ];
  },
  // VAR Q1 — `/sessions` is the canonical path. `/replays/*` is a permanent
  // redirect (301) to its new home so external links, Slack/email
  // notifications generated before the rename, and any cached search results
  // continue to land on the right page. Browser bookmark survival matters
  // more than 301-vs-302 SEO nuance here.
  async redirects() {
    return [
      { source: "/replays",                  destination: "/sessions",                  permanent: true },
      { source: "/replays/:sessionId",       destination: "/sessions/:sessionId",       permanent: true },
      { source: "/replays/users/:endUserId", destination: "/sessions/users/:endUserId", permanent: true },
    ];
  },
};

export default config;
