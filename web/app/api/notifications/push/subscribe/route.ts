import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, notificationChannels } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;

  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json(
      { error: "Invalid push subscription: missing endpoint or keys." },
      { status: 400 }
    );
  }

  const config = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
  };

  // Upsert: check if user already has a push channel with the same endpoint
  const existing = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        sql`${notificationChannels.type}::text = 'push'`,
        sql`${notificationChannels.config}->>'endpoint' = ${sub.endpoint}`
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Update existing subscription
    await db
      .update(notificationChannels)
      .set({ config, isActive: true, verifiedAt: new Date() })
      .where(eq(notificationChannels.id, existing[0].id));
  } else {
    await db.insert(notificationChannels).values({
      userId,
      type: "push",
      config,
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  return NextResponse.json({ ok: true });
}
