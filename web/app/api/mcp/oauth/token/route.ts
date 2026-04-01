import { NextResponse } from "next/server";
import { db, mcpOauthCodes, mcpOauthClients, mcpTokens } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import { rateLimit } from "@/lib/auth-rate-limit";

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * POST /api/mcp/oauth/token — exchange auth code + code_verifier for Bearer token.
 */
export async function POST(request: Request) {
  // Rate limit: 20 attempts per minute per IP
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimit("mcp_oauth_token", ip, { windowMs: 60_000, max: 20 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", error_description: `Retry in ${rl.retryAfterSeconds}s` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds ?? 60) } }
    );
  }

  let grantType: string, code: string, codeVerifier: string, clientId: string, redirectUri: string;

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    grantType = body.grant_type;
    code = body.code;
    codeVerifier = body.code_verifier;
    clientId = body.client_id;
    redirectUri = body.redirect_uri;
  } else {
    const form = await request.formData();
    grantType = form.get("grant_type") as string;
    code = form.get("code") as string;
    codeVerifier = form.get("code_verifier") as string;
    clientId = form.get("client_id") as string;
    redirectUri = form.get("redirect_uri") as string;
  }

  if (grantType !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  if (!code || !codeVerifier || !clientId || !redirectUri) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "code, code_verifier, client_id, and redirect_uri are required" },
      { status: 400 }
    );
  }

  // Validate client_id is registered
  const [client] = await db
    .select({ id: mcpOauthClients.id })
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.clientId, clientId))
    .limit(1);

  if (!client) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "Unregistered client_id" },
      { status: 400 }
    );
  }

  // Atomic: SELECT + DELETE in one step to prevent race condition (TOCTOU)
  const deleted = await db
    .delete(mcpOauthCodes)
    .where(
      and(
        eq(mcpOauthCodes.code, code),
        eq(mcpOauthCodes.clientId, clientId),
        gt(mcpOauthCodes.expiresAt, new Date())
      )
    )
    .returning();

  const authCode = deleted[0];
  if (!authCode) {
    return NextResponse.json(
      { error: "invalid_grant", error_description: "Code expired, not found, or already used" },
      { status: 400 }
    );
  }

  // Verify redirect_uri matches (mandatory per RFC 6749 4.1.3)
  if (redirectUri !== authCode.redirectUri) {
    return NextResponse.json(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      { status: 400 }
    );
  }

  // PKCE S256 verification
  const expectedChallenge = base64UrlEncode(
    createHash("sha256").update(codeVerifier).digest()
  );

  if (expectedChallenge !== authCode.codeChallenge) {
    return NextResponse.json(
      { error: "invalid_grant", error_description: "PKCE verification failed" },
      { status: 400 }
    );
  }

  // Create a Bearer token in mcpTokens (store only hash)
  const token = `inari_oauth_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");

  await db.insert(mcpTokens).values({
    userId: authCode.userId,
    name: `OAuth: ${clientId}`,
    tokenHash,
    scopes: authCode.scopes,
  });

  return NextResponse.json({
    access_token: token,
    token_type: "Bearer",
    scope: authCode.scopes.join(" "),
  });
}
