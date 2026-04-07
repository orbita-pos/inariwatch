import { NextRequest, NextResponse } from "next/server";
import { db, apiKeys } from "@/lib/db";
import { cliPendingCodes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
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

  // client=mobile → separate token that won't be revoked by CLI re-auth
  const client = req.nextUrl.searchParams.get("client");
  const service = client === "mobile" ? "mobile" : "cli";

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
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.userId, pending.userId), eq(apiKeys.service, service)));
  await db.insert(apiKeys).values({
    userId:       pending.userId,
    service,
    keyEncrypted: encrypt(apiToken),
    keyHash:      createHash("sha256").update(apiToken).digest("hex"),
  });

  // Consume the pending code
  await db.delete(cliPendingCodes).where(eq(cliPendingCodes.code, code));

  return NextResponse.json({ status: "approved", apiToken });
}
