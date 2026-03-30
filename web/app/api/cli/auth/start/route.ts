import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cliPendingCodes } from "@/lib/db/schema";
import { randomBytes } from "crypto";

/**
 * POST /api/cli/auth/start
 *
 * No auth required. Generates a short-lived code for the CLI device flow.
 * Returns { code, verifyUrl } — the CLI polls /api/cli/auth/poll until approved.
 */
export async function POST() {
  const code      = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await db.insert(cliPendingCodes).values({ code, expiresAt });

  const appUrl = process.env.APP_URL ?? "https://app.inariwatch.com";
  return NextResponse.json({
    code,
    verifyUrl: `${appUrl}/cli/verify?code=${code}`,
  });
}
