import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { signValue } from "@/lib/webhooks/shared";

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? "";
const SCOPES = [
  "chat:write",
  "commands",
  "app_mentions:read",
  "channels:read",
  "im:read",
  "im:write",
  "im:history",
  "users:read",
].join(",");

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!SLACK_CLIENT_ID) {
    return NextResponse.json({ error: "Slack not configured" }, { status: 500 });
  }

  const state = signValue(userId);
  const redirectUri = `${process.env.APP_URL || process.env.NEXTAUTH_URL}/api/slack/oauth/callback`;

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", SLACK_CLIENT_ID);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
