import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack/verify";
import {
  resolveSlackUser,
  acknowledgeAlertCore,
  resolveAlertCore,
  approveRemediationCore,
  cancelRemediationCore,
} from "@/lib/slack/actions";
import { runSlackRemediation } from "@/lib/slack/remediation-bridge";
import { rateLimit } from "@/lib/auth-rate-limit";
import { waitUntil } from "@vercel/functions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { valid, body } = await verifySlackRequest(req);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  // Slack sends interactions as URL-encoded with a "payload" field
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");
  if (!payloadStr) return new Response("Missing payload", { status: 400 });

  const payload = JSON.parse(payloadStr);
  const actionId = payload.actions?.[0]?.action_id;
  const actionValue = payload.actions?.[0]?.value;
  const slackUserId = payload.user?.id;
  const installationTeamId = payload.team?.id;

  if (!actionId || !slackUserId) {
    return NextResponse.json({ ok: true }); // ack silently
  }

  // Resolve Slack user → InariWatch user
  // We need the installationId, but we only have teamId from the payload
  // For now, use a helper to look up by team
  const { db, slackInstallations } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  const [install] = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, installationTeamId))
    .limit(1);

  if (!install) return NextResponse.json({ text: "Workspace not connected." });

  const userId = await resolveSlackUser(slackUserId, install.id);
  if (!userId) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Your Slack account is not linked to InariWatch. Ask your admin to set up user linking.",
    });
  }

  // Rate limit
  const rl = await rateLimit("slack-interaction", userId, { windowMs: 60_000, max: 30 });
  if (!rl.allowed) {
    return NextResponse.json({ response_type: "ephemeral", text: "Rate limited. Try again shortly." });
  }

  // Route actions
  switch (actionId) {
    case "ack_alert": {
      const result = await acknowledgeAlertCore(actionValue, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":eyes: Alert acknowledged." });
    }

    case "resolve_alert": {
      const result = await resolveAlertCore(actionValue, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: Alert resolved." });
    }

    case "fix_alert": {
      // Ack immediately, run remediation in background
      const responseUrl = payload.response_url;
      waitUntil(runSlackRemediation(actionValue, userId, responseUrl));
      return NextResponse.json({ response_type: "ephemeral", text: ":gear: Starting remediation..." });
    }

    case "approve_remediation": {
      const sessionId = payload.actions?.[0]?.value;
      const result = await approveRemediationCore(sessionId, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: Remediation approved." });
    }

    case "cancel_remediation": {
      const sessionId = payload.actions?.[0]?.value;
      const result = await cancelRemediationCore(sessionId, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":x: Remediation cancelled." });
    }

    default:
      return NextResponse.json({ ok: true });
  }
}
