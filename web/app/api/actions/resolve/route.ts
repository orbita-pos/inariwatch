import { NextResponse } from "next/server";
import { db, alerts } from "@/lib/db";
import { eq } from "drizzle-orm";
import { verifySignedValue, ACTION_LINK_TTL } from "@/lib/webhooks/shared";

/** GET shows a confirmation page; POST executes the action. */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const sig = url.searchParams.get("sig");

  if (!id || !sig || !verifySignedValue(id, sig, ACTION_LINK_TTL)) {
    return new NextResponse(
      renderHtml("Error", "Invalid or expired authorization link.", false),
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  // Show confirmation page instead of mutating on GET
  return new NextResponse(
    renderConfirmHtml(id, sig),
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

export async function POST(req: Request) {
  let body: { id?: string; sig?: string };
  try {
    body = await req.json();
  } catch {
    // Fall back to form data
    const formData = await req.formData().catch(() => null);
    body = {
      id: formData?.get("id")?.toString(),
      sig: formData?.get("sig")?.toString(),
    };
  }

  const { id, sig } = body;

  if (!id || !sig || !verifySignedValue(id, sig, ACTION_LINK_TTL)) {
    return new NextResponse(
      renderHtml("Error", "Invalid or expired authorization link.", false),
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  try {
    await db
      .update(alerts)
      .set({ isRead: true, isResolved: true })
      .where(eq(alerts.id, id));

    return new NextResponse(
      renderHtml("Resolved", "The alert has been marked as resolved.", true),
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  } catch {
    return new NextResponse(
      renderHtml("Error", "Failed to resolve the alert.", false),
      { status: 500, headers: { "Content-Type": "text/html" } }
    );
  }
}

function renderConfirmHtml(id: string, sig: string) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resolve Alert - InariWatch</title>
  <style>
    body { margin:0;padding:0;background-color:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh; }
    .card { background-color:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;max-width:400px;width:90%;text-align:center; }
    .icon { display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background-color:#10b98120;color:#10b981;font-size:24px;font-weight:bold;margin:0 auto 16px; }
    h1 { font-size:20px;font-weight:600;margin:0 0 8px; }
    p { color:#a1a1aa;font-size:14px;line-height:1.5;margin:0 0 24px; }
    button { display:inline-block;background-color:#fafafa;color:#09090b;border:none;cursor:pointer;font-weight:500;font-size:14px;padding:10px 20px;border-radius:6px;transition:opacity 0.2s; }
    button:hover { opacity:0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Resolve Alert</h1>
    <p>Click below to resolve this alert and mark it as handled.</p>
    <form method="POST" action="/api/actions/resolve">
      <input type="hidden" name="id" value="${id}" />
      <input type="hidden" name="sig" value="${sig}" />
      <button type="submit">Confirm Resolve</button>
    </form>
  </div>
</body>
</html>
  `;
}

function renderHtml(title: string, message: string, success: boolean) {
  const color = success ? "#10b981" : "#ef4444";
  const icon = success ? "✓" : "✕";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - InariWatch</title>
  <style>
    body { margin:0;padding:0;background-color:#09090b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh; }
    .card { background-color:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;max-width:400px;width:90%;text-align:center; }
    .icon { display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background-color:${color}20;color:${color};font-size:24px;font-weight:bold;margin:0 auto 16px; }
    h1 { font-size:20px;font-weight:600;margin:0 0 8px; }
    p { color:#a1a1aa;font-size:14px;line-height:1.5;margin:0 0 24px; }
    a { display:inline-block;background-color:#fafafa;color:#09090b;text-decoration:none;font-weight:500;font-size:14px;padding:10px 20px;border-radius:6px;transition:opacity 0.2s; }
    a:hover { opacity:0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="https://app.inariwatch.com">Open Dashboard</a>
  </div>
</body>
</html>
  `;
}
