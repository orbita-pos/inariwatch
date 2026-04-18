import type { NextConfig } from "next";
import { withInariWatch } from "@inariwatch/capture/next";

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

export default withInariWatch(config as Record<string, unknown>) as NextConfig;
