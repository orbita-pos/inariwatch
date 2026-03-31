import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, mcpOauthCodes } from "@/lib/db";
import { randomBytes } from "crypto";

// Only allow HTTPS redirect URIs (except localhost for dev)
function isValidRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * GET /api/mcp/oauth/authorize — shows approval page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const state = url.searchParams.get("state") ?? "";
  const scope = url.searchParams.get("scope") ?? "read";

  if (!clientId || !redirectUri || !codeChallenge) {
    return new Response("Missing required parameters: client_id, redirect_uri, code_challenge", { status: 400 });
  }

  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return new Response("Only S256 code_challenge_method is supported", { status: 400 });
  }

  if (!isValidRedirectUri(redirectUri)) {
    return new Response("Invalid redirect_uri: must be HTTPS (or localhost for development)", { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) {
    const base = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://app.inariwatch.com";
    const callbackUrl = encodeURIComponent(request.url);
    return NextResponse.redirect(`${base}/login?callbackUrl=${callbackUrl}`);
  }

  // Generate CSRF token
  const csrfToken = randomBytes(32).toString("hex");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize — InariWatch MCP</title>
<style>body{font-family:system-ui;background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#111;border:1px solid #222;border-radius:12px;padding:32px;max-width:420px;width:100%}
h1{font-size:18px;margin:0 0 8px}p{color:#999;font-size:14px;margin:0 0 20px}
.scope{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:12px;margin:0 0 20px;font-family:monospace;font-size:13px}
.uri{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:8px 12px;margin:0 0 20px;font-size:11px;color:#888;word-break:break-all}
.btns{display:flex;gap:8px}
button{flex:1;padding:10px;border-radius:8px;border:none;font-size:14px;font-weight:500;cursor:pointer}
.approve{background:#22c55e;color:#000}.deny{background:#222;color:#999}
</style></head>
<body>
<div class="card">
  <h1>Authorize MCP Connection</h1>
  <p><strong>${escapeHtml(clientId)}</strong> wants to connect to your InariWatch account.</p>
  <div class="scope">Scopes: <strong>${escapeHtml(scope)}</strong></div>
  <div class="uri">Redirect: ${escapeHtml(redirectUri)}</div>
  <form method="POST">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input type="hidden" name="scope" value="${escapeHtml(scope)}">
    <div class="btns">
      <button type="submit" name="action" value="deny" class="deny">Deny</button>
      <button type="submit" name="action" value="approve" class="approve">Approve</button>
    </div>
  </form>
</div>
</body></html>`;

  // Set CSRF token as HttpOnly cookie
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Set-Cookie": `mcp_csrf=${csrfToken}; Path=/api/mcp/oauth; HttpOnly; SameSite=Strict; Secure; Max-Age=600`,
    },
  });
}

/**
 * POST /api/mcp/oauth/authorize — processes approval/denial.
 */
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const form = await request.formData();

  // CSRF validation
  const csrfFromForm = form.get("csrf_token") as string;
  const cookies = request.headers.get("cookie") ?? "";
  const csrfFromCookie = cookies.match(/mcp_csrf=([a-f0-9]+)/)?.[1];
  if (!csrfFromForm || !csrfFromCookie || csrfFromForm !== csrfFromCookie) {
    return new Response("CSRF validation failed", { status: 403 });
  }

  const action = form.get("action") as string;
  const clientId = form.get("client_id") as string;
  const redirectUri = form.get("redirect_uri") as string;
  const codeChallenge = form.get("code_challenge") as string;
  const state = form.get("state") as string;
  const scope = form.get("scope") as string || "read";

  // Validate redirect_uri again
  if (!isValidRedirectUri(redirectUri)) {
    return new Response("Invalid redirect_uri", { status: 400 });
  }

  if (action === "deny") {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    return NextResponse.redirect(url.toString());
  }

  // Generate auth code
  const code = randomBytes(32).toString("hex");

  await db.insert(mcpOauthCodes).values({
    code,
    userId,
    clientId,
    codeChallenge,
    redirectUri,
    scopes: scope.split(/\s+/).filter(Boolean),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
