import { NextResponse } from "next/server";
import crypto from "crypto";
import { db, deployMonitors } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getSlackClient } from "@/lib/slack/client";
import { buildDeployFollowUpBlocks } from "@/lib/slack/blocks";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/cron/deploy-monitor/notify
 *
 * Called by the Hetzner worker to post Slack follow-up messages.
 * Worker handles DB queries + timing, Vercel handles Slack (has tokens).
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!CRON_SECRET || !auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const expected = Buffer.from(`Bearer ${CRON_SECRET}`);
  const actual = Buffer.from(auth);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { channelId, threadTs, installationId, deploySource, healthy, errorCount } =
    await req.json() as {
      monitorId: string;
      channelId: string;
      threadTs: string;
      installationId: string;
      deploySource: string;
      healthy: boolean;
      errorCount: number;
    };

  try {
    const client = await getSlackClient(installationId);
    const blocks = buildDeployFollowUpBlocks(healthy, errorCount, deploySource);
    const sourceLabel = deploySource && deploySource !== "vercel" ? ` (${deploySource})` : "";

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: healthy
        ? `Deploy${sourceLabel} looks healthy.`
        : `Deploy${sourceLabel} may be causing issues (${errorCount} errors).`,
      blocks,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[deploy-monitor/notify]", err);
    return NextResponse.json({ ok: false, error: "Slack post failed" }, { status: 500 });
  }
}
