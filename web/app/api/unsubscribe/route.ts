import { NextRequest, NextResponse } from "next/server";
import { db, blogSubscribers } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return new NextResponse("Missing token.", { status: 400 });
  }

  const [sub] = await db
    .select({ id: blogSubscribers.id, email: blogSubscribers.email })
    .from(blogSubscribers)
    .where(eq(blogSubscribers.unsubscribeToken, token))
    .limit(1);

  if (!sub) {
    return new NextResponse("Token not found or already unsubscribed.", { status: 404 });
  }

  await db.delete(blogSubscribers).where(eq(blogSubscribers.id, sub.id));

  return new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
    <style>body{font-family:system-ui,sans-serif;background:#09090b;color:#a1a1aa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{text-align:center;max-width:400px;padding:40px 20px}h1{color:#fff;font-size:20px;margin-bottom:8px}a{color:#7C3AED}</style></head>
    <body><div class="box"><h1>Unsubscribed</h1>
    <p>${sub.email} has been removed from the InariWatch blog newsletter.</p>
    <p style="margin-top:24px"><a href="https://inariwatch.com/blog">Back to blog</a></p>
    </div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}
