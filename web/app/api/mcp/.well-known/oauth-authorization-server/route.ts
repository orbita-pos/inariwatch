import { NextResponse } from "next/server";

export async function GET() {
  const base = process.env.APP_URL || process.env.NEXTAUTH_URL || "https://app.inariwatch.com";

  return NextResponse.json({
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write", "execute"],
  });
}
