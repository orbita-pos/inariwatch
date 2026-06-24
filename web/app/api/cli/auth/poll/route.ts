import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cliPendingCodes, deviceTokens } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";
import { randomBytes, createHash } from "crypto";

/**
 * GET /api/cli/auth/poll?code=...
 *
 * Called by the CLI / Inari Live every 2s after opening the browser
 * verify page. Returns { status: "pending" | "approved" | "expired" | "invalid" }.
 * When approved, also returns { apiToken } (and { deviceId } for desktop).
 *
 * Token storage by client:
 *   - client=cli      → encrypted row in api_keys (legacy CLI flow)
 *   - client=mobile   → encrypted row in api_keys (mobile app)
 *   - client=desktop  → SHA-256 hash row in device_tokens (Session 1).
 *                       Each approval mints a NEW token + NEW device_tokens
 *                       row, so multiple Inari Live installs on the same
 *                       account no longer overwrite each other.
 *
 * Desktop-only optional query params (Session 1):
 *   - label         human-readable device label (default: hostname or "Inari Live")
 *   - os            "windows" | "macos" | "linux"
 *   - hostname      raw hostname for display
 *   - app_version   semver from the desktop binary
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json({ status: "invalid" }, { status: 400 });

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

  const apiToken = `inari_${service}_${randomBytes(24).toString("hex")}`;

  if (service === "desktop") {
    const tokenHash = createHash("sha256").update(apiToken).digest("hex");

    const params      = req.nextUrl.searchParams;
    const rawLabel    = params.get("label")?.trim();
    const rawHostname = params.get("hostname")?.trim();
    const rawOs       = params.get("os")?.trim().toLowerCase();
    const rawVersion  = params.get("app_version")?.trim();

    // Defensive caps so a misbehaving client can't bloat the row.
    const label    = (rawLabel || rawHostname || "Inari Live").slice(0, 64);
    const hostname = rawHostname ? rawHostname.slice(0, 128) : null;
    const os       = rawOs && /^(windows|macos|linux)$/.test(rawOs) ? rawOs : null;
    const version  = rawVersion ? rawVersion.slice(0, 32) : null;

    const [row] = await db
      .insert(deviceTokens)
      .values({
        userId:     pending.userId,
        tokenHash,
        label,
        os,
        hostname,
        appVersion: version,
      })
      .returning({ deviceId: deviceTokens.deviceId });

    await db.delete(cliPendingCodes).where(eq(cliPendingCodes.code, code));

    return NextResponse.json({
      status:   "approved",
      apiToken,
      deviceId: row?.deviceId ?? null,
    });
  }

  // Legacy CLI / mobile path — single-row api_keys, unchanged.
  const encrypted = encrypt(apiToken);
  const keyHash   = createHash("sha256").update(apiToken).digest("hex");
  await db.execute(sql`DELETE FROM api_keys WHERE user_id = ${pending.userId} AND service = ${service}`);
  await db.execute(sql`INSERT INTO api_keys (user_id, service, key_encrypted, key_hash) VALUES (${pending.userId}, ${service}, ${encrypted}, ${keyHash})`);

  await db.delete(cliPendingCodes).where(eq(cliPendingCodes.code, code));

  return NextResponse.json({ status: "approved", apiToken });
}
