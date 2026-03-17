import { NextResponse } from "next/server";
import { db, notificationChannels } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { suppressEmail } from "@/lib/notifications/rate-limit";
import { verifySignedValue } from "@/lib/webhooks/shared";

/**
 * GET /api/notifications/unsubscribe?email=user@example.com&token=<hmac>
 *
 * One-click unsubscribe link included in every alert email.
 * Requires a valid HMAC token to prevent unauthorized suppression.
 * Adds the email to the suppression list and deactivates the channel.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const token = url.searchParams.get("token") ?? "";

  if (!email || !email.includes("@")) {
    return new NextResponse(renderPage("Invalid unsubscribe link.", false), {
      headers: { "Content-Type": "text/html" },
      status: 400,
    });
  }

  // Verify the signed token — prevents anyone from unsubscribing arbitrary emails
  if (!verifySignedValue(email.toLowerCase(), token)) {
    return new NextResponse(renderPage("Invalid or expired unsubscribe link.", false), {
      headers: { "Content-Type": "text/html" },
      status: 403,
    });
  }

  // Add to suppression list
  await suppressEmail(email, "unsubscribe");

  // Deactivate any email notification channels with this address
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.type, "email"));

  for (const channel of channels) {
    const config = channel.config as Record<string, string>;
    if (config.email?.toLowerCase() === email.toLowerCase()) {
      await db
        .update(notificationChannels)
        .set({ isActive: false })
        .where(eq(notificationChannels.id, channel.id));
    }
  }

  return new NextResponse(
    renderPage("You've been unsubscribed from InariWatch email alerts.", true),
    { headers: { "Content-Type": "text/html" } }
  );
}

function renderPage(message: string, success: boolean): string {
  const color = success ? "#22c55e" : "#7C3AED";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe — InariWatch</title></head>
<body style="margin:0;padding:0;background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="text-align:center;max-width:400px;padding:40px 20px;">
    <div style="width:48px;height:48px;border-radius:50%;background:${color}22;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
      <span style="font-size:24px;">${success ? "\u2713" : "\u2717"}</span>
    </div>
    <h1 style="font-size:18px;font-weight:600;margin:0 0 8px;color:#fafafa;">
      ${success ? "Unsubscribed" : "Error"}
    </h1>
    <p style="font-size:14px;color:#a1a1aa;margin:0 0 24px;line-height:1.5;">
      ${message}
    </p>
    <p style="font-size:12px;color:#52525b;">
      You can re-enable email notifications anytime in your
      <a href="${process.env.NEXTAUTH_URL ?? "https://inariwatch.com"}/settings" style="color:#7C3AED;text-decoration:underline;">InariWatch settings</a>.
    </p>
  </div>
</body>
</html>`;
}
