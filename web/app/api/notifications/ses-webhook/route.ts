import { NextResponse } from "next/server";
import { suppressEmail } from "@/lib/notifications/rate-limit";
import { checkWebhookRateLimit } from "@/lib/webhooks/rate-limit";

const SES_WEBHOOK_SECRET = process.env.SES_WEBHOOK_SECRET;

/**
 * POST /api/notifications/ses-webhook
 *
 * Handles Amazon SES bounce and complaint notifications via SNS.
 * Setup: SES → SNS topic → HTTPS subscription → this endpoint.
 *
 * On bounce/complaint, the offending email is added to the suppression list
 * so we never send to it again.
 */
export async function POST(req: Request) {
  // Rate limiting
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = checkWebhookRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }

  // Require secret — fail closed
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!SES_WEBHOOK_SECRET || secret !== SES_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  // SNS sends a SubscriptionConfirmation on first setup — auto-confirm it
  // Validate that the URL belongs to AWS SNS to prevent SSRF
  if (body.Type === "SubscriptionConfirmation" && body.SubscribeURL) {
    const subscribeUrl = new URL(body.SubscribeURL);
    if (!subscribeUrl.hostname.endsWith(".amazonaws.com") || subscribeUrl.protocol !== "https:") {
      return NextResponse.json({ error: "Invalid SubscribeURL" }, { status: 400 });
    }
    await fetch(body.SubscribeURL);
    return NextResponse.json({ ok: true, action: "subscription_confirmed" });
  }

  // Parse SNS notification
  if (body.Type !== "Notification") {
    return NextResponse.json({ ok: true, action: "ignored" });
  }

  let message: Record<string, unknown>;
  try {
    message = typeof body.Message === "string" ? JSON.parse(body.Message) : body.Message;
  } catch {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  const notifType = message.notificationType as string | undefined;

  if (notifType === "Bounce") {
    const bounce = message.bounce as Record<string, unknown> | undefined;
    const recipients = (bounce?.bouncedRecipients ?? []) as Array<{ emailAddress: string }>;
    for (const r of recipients) {
      await suppressEmail(r.emailAddress, "bounce");
    }
    return NextResponse.json({ ok: true, action: "bounce_suppressed", count: recipients.length });
  }

  if (notifType === "Complaint") {
    const complaint = message.complaint as Record<string, unknown> | undefined;
    const recipients = (complaint?.complainedRecipients ?? []) as Array<{ emailAddress: string }>;
    for (const r of recipients) {
      await suppressEmail(r.emailAddress, "complaint");
    }
    return NextResponse.json({ ok: true, action: "complaint_suppressed", count: recipients.length });
  }

  return NextResponse.json({ ok: true, action: "ignored" });
}
