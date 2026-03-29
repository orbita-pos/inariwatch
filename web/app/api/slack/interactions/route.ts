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

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Validate payload structure
  const actions = Array.isArray(payload.actions) ? payload.actions : null;
  const user = payload.user && typeof payload.user === "object" ? payload.user as Record<string, unknown> : null;
  const team = payload.team && typeof payload.team === "object" ? payload.team as Record<string, unknown> : null;

  const actionId = actions?.[0]?.action_id as string | undefined;
  const actionValue = actions?.[0]?.value as string | undefined;
  const slackUserId = user?.id as string | undefined;
  const installationTeamId = team?.id as string | undefined;

  if (!actionId || !slackUserId || !installationTeamId) {
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

  // Route actions — actionValue is guaranteed string at this point
  const value = actionValue || "";
  const responseUrl = (payload.response_url as string) || "";
  const message = (payload.message ?? {}) as Record<string, unknown>;

  switch (actionId) {
    case "ack_alert": {
      const result = await acknowledgeAlertCore(value, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":eyes: Alert acknowledged." });
    }

    case "resolve_alert": {
      const result = await resolveAlertCore(value, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: Alert resolved." });
    }

    case "fix_alert": {
      waitUntil(runSlackRemediation(value, userId, responseUrl));
      return NextResponse.json({ response_type: "ephemeral", text: ":gear: Starting remediation..." });
    }

    case "apply_community_fix": {
      // Community fix = run remediation but the pipeline will use the community fix hint
      waitUntil(runSlackRemediation(value, userId, responseUrl));
      return NextResponse.json({ response_type: "ephemeral", text: ":bulb: Applying community fix..." });
    }

    case "approve_remediation": {
      const result = await approveRemediationCore(value, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":white_check_mark: Remediation approved." });
    }

    case "cancel_remediation": {
      const result = await cancelRemediationCore(value, userId);
      if (result.error) return NextResponse.json({ response_type: "ephemeral", text: result.error });
      return NextResponse.json({ response_type: "ephemeral", text: ":x: Remediation cancelled." });
    }

    case "generate_postmortem": {
      waitUntil((async () => {
        try {
          const { slackMessageThreads, alerts: alertsTable } = await import("@/lib/db");
          const threadTs = (message.thread_ts as string) || (message.ts as string);
          if (!threadTs) return;

          const [thread] = await db
            .select()
            .from(slackMessageThreads)
            .where(eq(slackMessageThreads.threadTs, threadTs))
            .limit(1);

          if (!thread?.alertId) return;

          const { generatePostmortemInternal } = await import("@/lib/ai/postmortem");
          await generatePostmortemInternal(thread.alertId);

          const { sendPostmortem } = await import("@/lib/slack/send");
          const [alert] = await db.select().from(alertsTable).where(eq(alertsTable.id, thread.alertId)).limit(1);
          if (alert?.postmortem) {
            await sendPostmortem(thread.alertId, alert.postmortem, alert.title);
          }
        } catch (err) {
          console.error("[slack/interactions] postmortem error:", err);
        }
      })());
      return NextResponse.json({ response_type: "ephemeral", text: ":page_facing_up: Generating postmortem..." });
    }

    default:
      return NextResponse.json({ ok: true });
  }
}
