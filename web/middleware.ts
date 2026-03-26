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

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  if (isAlwaysAllowed(pathname)) return NextResponse.next();

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
    return NextResponse.next();
  }

  // ── Root domain (inariwatch.com / www.inariwatch.com) ─────────────────────
  const isRootDomain = host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}`;
  if (isRootDomain) {
    if (hasSession(req) && (pathname === "/" || pathname === "/login" || pathname === "/register")) {
      const url = req.nextUrl.clone();
      url.host = APP_SUBDOMAIN;
      url.pathname = "/dashboard";
      url.protocol = "https:";
      return NextResponse.redirect(url, { status: 302 });
    }

    if (
      pathname === "/" ||
      pathname.startsWith("/blog") ||
      pathname.startsWith("/docs") ||
      pathname.startsWith("/trust") ||
      pathname.startsWith("/pricing") ||
      pathname.startsWith("/privacy") ||
      pathname.startsWith("/terms") ||
      pathname.startsWith("/status") ||
      pathname.endsWith(".mp4") ||
      pathname.endsWith(".webm")
    ) {
      return NextResponse.next();
    }
    const url = req.nextUrl.clone();
    url.host = APP_SUBDOMAIN;
    url.protocol = "https:";
    return NextResponse.redirect(url, { status: 301 });
  }

  // ── App subdomain (app.inariwatch.com) ────────────────────────────────────
  const isAppSubdomain = host === APP_SUBDOMAIN;
  if (isAppSubdomain) {
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.host = ROOT_DOMAIN;
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
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
