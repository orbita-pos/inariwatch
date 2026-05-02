import { NextRequest, NextResponse } from "next/server";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "inariwatch.com";
const APP_SUBDOMAIN = `app.${ROOT_DOMAIN}`;

const PROTECTED_PATHS = [
  "/dashboard",
  "/projects",
  "/alerts",
  "/chat",
  "/integrations",
  "/settings",
  "/admin",
  "/recordings",
];

const ALWAYS_ALLOWED = [
  "/api/",
  "/_next/",
  "/favicon",
  "/robots",
  "/sitemap",
];

function isAlwaysAllowed(pathname: string) {
  return ALWAYS_ALLOWED.some((p) => pathname.startsWith(p));
}

function isProtected(pathname: string) {
  return PROTECTED_PATHS.some((p) => pathname.startsWith(p));
}

// Check session cookie presence — actual JWT verification happens server-side
function hasSession(req: NextRequest): boolean {
  return !!(
    req.cookies.get("next-auth.session-token") ||
    req.cookies.get("__Secure-next-auth.session-token")
  );
}

// ── CSP (B1 — Vercel-level audit) ─────────────────────────────────────────
//
// Strict CSP with per-request nonce + `strict-dynamic`. Fixes the
// `'unsafe-inline'` in script-src that was blocking Mozilla Observatory
// A+.
//
// Rollout is gated by CSP_ENFORCE:
//   unset | "false"  → Content-Security-Policy-Report-Only  (default)
//   "true"           → Content-Security-Policy              (enforcing)
//
// Ship Report-Only for ~48 h, watch `/api/csp-report` for violations,
// then flip CSP_ENFORCE=true in sops. No code change required to enforce.

function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  // HMR + React Refresh need unsafe-eval in dev. In prod, strict-dynamic
  // + nonce covers everything Next emits (hydration scripts carry the
  // nonce we set on the request).
  const scriptSrc = [
    `'nonce-${nonce}'`,
    `'strict-dynamic'`,
    // 'self' for same-origin script URLs; legacy UAs without
    // strict-dynamic support fall back to this. Modern browsers with
    // strict-dynamic ignore the host list entirely.
    "'self'",
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind injects runtime inline style; nonce on style-src would
    // require a Tailwind build-time change. 'unsafe-inline' is broadly
    // acceptable for CSS (CVE surface is tiny).
    "style-src 'self' 'unsafe-inline'",
    // Avatars: GitHub, Google, Gravatar. `data:` for inline SVG/blur.
    "img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://secure.gravatar.com https://gitlab.com",
    "media-src 'self'",
    "font-src 'self' data:",
    // Narrow from the previous `connect-src 'self' https:` which allowed
    // exfiltration to any https origin. Cross-subdomain (`app.*` → root
    // and vice versa) is required for Next RSC prefetches on `<Link>`
    // components that navigate between the marketing and app surfaces.
    "connect-src 'self' https://inariwatch.com https://app.inariwatch.com https://api.github.com",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
    // CSP violation reports land at /api/csp-report (next step in this
    // plan). `report-to` is the modern directive; `report-uri` kept for
    // Firefox + older Safari that ignore report-to.
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
  ].join("; ");
}

// Wrap NextResponse.next() / .rewrite() so every page response carries a
// fresh nonce + the matching CSP. Redirects skip this — they have no body.
function withCsp(req: NextRequest, kind: "next" | "rewrite", url?: URL): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce);
  const reqHeaders = new Headers(req.headers);
  // Next 15 reads `x-nonce` and applies it to framework-emitted scripts.
  reqHeaders.set("x-nonce", nonce);
  reqHeaders.set("Content-Security-Policy", csp);

  const res = kind === "rewrite" && url
    ? NextResponse.rewrite(url, { request: { headers: reqHeaders } })
    : NextResponse.next({ request: { headers: reqHeaders } });

  const enforce = process.env.CSP_ENFORCE === "true";
  const headerName = enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
  res.headers.set(headerName, csp);
  res.headers.set("x-nonce", nonce);
  res.headers.set(
    "Report-To",
    JSON.stringify({
      group: "csp-endpoint",
      max_age: 10_886_400,
      endpoints: [{ url: "/api/csp-report" }],
    }),
  );
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Resource-Policy", "same-site");
  // X-XSS-Protection is deprecated; OWASP + Mozilla recommend `0`.
  res.headers.set("X-XSS-Protection", "0");
  return res;
}

const nextWithCsp = (req: NextRequest) => withCsp(req, "next");
const rewriteWithCsp = (req: NextRequest, url: URL) => withCsp(req, "rewrite", url);

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  // Strip stray whitespace from the pathname (e.g. trailing %20 from a
  // misconfigured external Setup URL). 308 keeps the method + body so POST
  // webhooks survive the bounce; query string is preserved automatically.
  if (/\s/.test(pathname)) {
    const cleaned = pathname.replace(/\s+/g, "");
    if (cleaned !== pathname && cleaned.length > 0) {
      const url = req.nextUrl.clone();
      url.pathname = cleaned;
      return NextResponse.redirect(url, { status: 308 });
    }
  }

  // MCP subdomain rewrite — mcp.inariwatch.com → /api/mcp
  if (host.startsWith("mcp.")) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/mcp";
    return rewriteWithCsp(req, url);
  }

  // Install subdomain rewrite — install.inariwatch.com → /api/install
  // Serves the InariWatch Agent installer script from the public distribution repo.
  // Usage: curl -sf https://install.inariwatch.com | sh
  if (host.startsWith("install.")) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/install";
    return rewriteWithCsp(req, url);
  }

  // Verify subdomain rewrite — verify.inariwatch.com → /verify
  // (Sesión 29) Pure compute endpoint; no auth, no rate limit. Mirrors
  // the mcp.* pattern so a shareable URL like
  //   verify.inariwatch.com/r/<base64-eap-json>
  // round-trips to `/verify/r/<base64>` without leaking the host.
  if (host.startsWith("verify.")) {
    const url = req.nextUrl.clone();
    if (pathname === "/" || pathname === "") {
      url.pathname = "/verify";
    } else if (!pathname.startsWith("/verify")) {
      url.pathname = `/verify${pathname}`;
    }
    return rewriteWithCsp(req, url);
  }

  // Status subdomain rewrite — status.inariwatch.com → /status
  if (host.startsWith("status.")) {
    const url = req.nextUrl.clone();
    if (pathname === "/") {
      url.pathname = "/status";
    } else if (!pathname.startsWith("/status")) {
      url.pathname = `/status${pathname}`;
    }
    return rewriteWithCsp(req, url);
  }

  if (isAlwaysAllowed(pathname)) return nextWithCsp(req);

  // ── Local development ──────────────────────────────────────────────────────
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1");
  if (isLocalhost) {
    if (isProtected(pathname) && !hasSession(req)) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (hasSession(req) && (pathname === "/" || pathname === "/login" || pathname === "/register")) {
      const dashboardUrl = req.nextUrl.clone();
      dashboardUrl.pathname = "/dashboard";
      return NextResponse.redirect(dashboardUrl);
    }
    return nextWithCsp(req);
  }

  // ── Root domain (inariwatch.com / www.inariwatch.com) ─────────────────────
  const isRootDomain = host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}`;
  if (isRootDomain) {
    if (hasSession(req) && (pathname === "/" || pathname === "/login" || pathname === "/register")) {
      const url = req.nextUrl.clone();
      url.host = APP_SUBDOMAIN;
      url.port = "";
      url.pathname = "/dashboard";
      url.protocol = "https:";
      return NextResponse.redirect(url, { status: 302 });
    }

    if (
      pathname === "/" ||
      pathname.startsWith("/blog") ||
      pathname.startsWith("/docs") ||
      pathname.startsWith("/trust") ||
      pathname.startsWith("/network") ||
      pathname.startsWith("/pricing") ||
      pathname.startsWith("/privacy") ||
      pathname.startsWith("/terms") ||
      pathname.startsWith("/status") ||
      pathname.startsWith("/replay") ||
      pathname.startsWith("/verify") ||
      pathname.endsWith(".mp4") ||
      pathname.endsWith(".webm")
    ) {
      return nextWithCsp(req);
    }
    const url = req.nextUrl.clone();
    url.host = APP_SUBDOMAIN;
    url.port = "";
    url.protocol = "https:";
    return NextResponse.redirect(url, { status: 301 });
  }

  // ── App subdomain (app.inariwatch.com) ────────────────────────────────────
  const isAppSubdomain = host === APP_SUBDOMAIN;
  if (isAppSubdomain) {
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.host = ROOT_DOMAIN;
      url.port = "";
      url.protocol = "https:";
      return NextResponse.redirect(url, { status: 302 });
    }
    if (isProtected(pathname) && !hasSession(req)) {
      const loginUrl = req.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (hasSession(req) && (pathname === "/login" || pathname === "/register")) {
      const dashboardUrl = req.nextUrl.clone();
      dashboardUrl.pathname = "/dashboard";
      return NextResponse.redirect(dashboardUrl);
    }
    return nextWithCsp(req);
  }

  return nextWithCsp(req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
