import { NextRequest, NextResponse } from "next/server";
import { db, slackInstallations } from "@/lib/db";
import { eq } from "drizzle-orm";
import { encrypt } from "@/lib/crypto";
import { verifySignedValue } from "@/lib/webhooks/shared";

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? "";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  const appUrl = process.env.APP_URL || process.env.NEXTAUTH_URL || "";

  if (error) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=${error}`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=missing_params`);
  }

  // Verify state signature FIRST, then extract userId
  const parts = state.split(":");
  if (parts.length < 3) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=invalid_state`);
  }
  // Verify before trusting any data from the state
  const candidateUserId = parts[0];
  const isValid = verifySignedValue(candidateUserId, state, 600); // 10 min TTL
  if (!isValid) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=expired_state`);
  }
  // Only use userId AFTER verification succeeds
  const userId = candidateUserId;

  // Exchange code for bot token
  const redirectUri = `${appUrl}/api/slack/oauth/callback`;
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await tokenRes.json();
  if (!data.ok) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=${data.error}`);
  }

  const teamId = data.team?.id;
  const teamName = data.team?.name ?? "Unknown";
  const botToken = data.access_token;
  const botUserId = data.bot_user_id;
  const scopes = (data.scope || "").split(",");

  if (!teamId || !botToken || !botUserId) {
    return NextResponse.redirect(`${appUrl}/settings?slack=error&reason=missing_token`);
  }

  // Upsert installation (one per workspace)
  const existing = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(slackInstallations)
      .set({
        botToken: encrypt(botToken),
        botUserId,
        scopes,
        teamName,
        userId,
        updatedAt: new Date(),
      })
      .where(eq(slackInstallations.teamId, teamId));
  } else {
    await db.insert(slackInstallations).values({
      userId,
      teamId,
      teamName,
      botToken: encrypt(botToken),
      botUserId,
      scopes,
    });
  }

  return NextResponse.redirect(`${appUrl}/settings?slack=success`);
}
