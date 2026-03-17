import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

// Production domains — override via env vars if needed
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "inariwatch.com";
const APP_SUBDOMAIN = `app.${ROOT_DOMAIN}`;

// Routes inside (dashboard) that require auth on the app subdomain
const PROTECTED_PATHS = [
  "/dashboard",
  "/projects",
  "/alerts",
  "/chat",
  "/integrations",
  "/settings",
];

// Routes that must always be accessible regardless of subdomain (API, assets, etc.)
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

export async function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  // Always allow API routes, static assets, etc.
  if (isAlwaysAllowed(pathname)) {
    return NextResponse.next();
  }

  // ── Local development: behave as if on app subdomain ──────────────────────
  const isLocalhost = host.includes("localhost") || host.includes("127.0.0.1");
  if (isLocalhost) {
    if (isProtected(pathname)) {
      const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
      if (!token) {
        const loginUrl = req.nextUrl.clone();
        loginUrl.pathname = "/login";
        loginUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(loginUrl);
      }
    }
    return NextResponse.next();
  }

  // ── Root domain (inariwatch.com / www.inariwatch.com) ────────────────────
  const isRootDomain =
    host === ROOT_DOMAIN ||
    host === `www.${ROOT_DOMAIN}`;

  if (isRootDomain) {
    // Marketing pages stay on root domain — only "/" and public routes
    if (pathname === "/" || pathname.startsWith("/blog") || pathname.startsWith("/pricing")) {
      return NextResponse.next();
    }

    // Everything else (login, dashboard, etc.) → redirect to app subdomain
    const url = req.nextUrl.clone();
    url.host = APP_SUBDOMAIN;
    url.protocol = "https:";
    return NextResponse.redirect(url, { status: 301 });
  }

  // ── App subdomain (app.inariwatch.com) ────────────────────────────────────
  const isAppSubdomain = host === APP_SUBDOMAIN;

  if (isAppSubdomain) {
    // Redirect marketing root to landing page
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.host = ROOT_DOMAIN;
      url.protocol = "https:";
      return NextResponse.redirect(url, { status: 302 });
    }

    // Protect dashboard routes
    if (isProtected(pathname)) {
      const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
      if (!token) {
        const loginUrl = req.nextUrl.clone();
        loginUrl.pathname = "/login";
        loginUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(loginUrl);
      }
    }

    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static files
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
