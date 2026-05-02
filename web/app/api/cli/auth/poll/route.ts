import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiKeys, cliPendingCodes } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";
import { randomBytes, createHash } from "crypto";

/**
 * GET /api/cli/auth/poll?code=...
 *
 * Called by the CLI every 2s after opening the browser verify page.
 * Returns { status: "pending" | "approved" | "expired" | "invalid" }
 * When approved, also returns { apiToken } and cleans up the pending code.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ status: "invalid" }, { status: 400 });

  // client=mobile / client=desktop → separate tokens that won't be revoked
  // by CLI re-auth. Inari Live (Tauri desktop app) ships its device flow
  // through this same route with `client=desktop`; the resulting token is
  // stored under service="desktop" so /api/desktop/* + authenticateExtensionToken()
  // can find it. Anything else falls back to the legacy "cli" service.
  const client = req.nextUrl.searchParams.get("client");
  const service =
    client === "mobile" || client === "desktop" ? client : "cli";

  const [pending] = await db
    .select()
    .from(cliPendingCodes)
    .where(eq(cliPendingCodes.code, code))
    .limit(1);

  if (!pending) return NextResponse.json({ status: "invalid" }, { status: 404 });

  if (new Date() > pending.expiresAt) {
    await db.delete(cliPendingCodes).where(eq(cliPendingCodes.code, code));
    return NextResponse.json({ status: "expired" });
  }

  if (!pending.approved || !pending.userId) {
    return NextResponse.json({ status: "pending" });
  }

  // Approved — issue a long-lived API token
  const apiToken = `inari_${service}_${randomBytes(24).toString("hex")}`;

  // Revoke any existing token for this user+service, then store the new one
  const encrypted = encrypt(apiToken);
  const keyHash = createHash("sha256").update(apiToken).digest("hex");
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${pending.userId} AND service = ${service}`);
  await db.execute(sql`INSERT INTO api_keys (user_id, service, key_encrypted, key_hash) VALUES (${pending.userId}, ${service}, ${encrypted}, ${keyHash})`);

  // Consume the pending code
  await db.delete(cliPendingCodes).where(eq(cliPendingCodes.code, code));

  return NextResponse.json({ status: "approved", apiToken });
}
