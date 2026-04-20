import type { NextConfig } from "next";
// withInariWatch wrapper intentionally NOT imported here — the published
// @inariwatch/capture@0.9.0's `./next` subpath exports only `import`/`default`
// conditions, no `require`. Next.js's config transpiler compiles this file
// to CJS and `require`s the plugin, which fails on ESM-only subpaths under
// Node 20. Dogfood capture continues to work via `instrumentation.ts` at
// runtime, which uses native ESM import. Re-add the wrapper once the
// capture package publishes with a `require` condition (next patch release).

const securityHeaders = [
  { key: "X-Content-Type-Options",  value: "nosniff" },
  { key: "X-Frame-Options",         value: "DENY" },
  { key: "X-XSS-Protection",        value: "1; mode=block" },
  { key: "Referrer-Policy",         value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy",      value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' https://plausible.io${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",                   // Tailwind injects inline styles
      "img-src 'self' data: https:",
      "media-src 'self'",
      "font-src 'self'",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
    ].join("; "),
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
    return [{ source: "/:path*", headers: securityHeaders }];
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
