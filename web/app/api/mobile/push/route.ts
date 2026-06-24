import { NextRequest, NextResponse } from "next/server";
import { db, notificationChannels } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { requireMobileAuth } from "@/lib/auth/mobile";

const EXPO_TOKEN_REGEX = /^ExponentPushToken\[[a-zA-Z0-9_-]+\]$/;

export async function POST(req: NextRequest) {
  const auth = await requireMobileAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const body = await req.json();
  const expoToken = body.expoToken as string;

  if (!expoToken || !EXPO_TOKEN_REGEX.test(expoToken) || expoToken.length > 100) {
    return NextResponse.json({ error: "Invalid Expo push token" }, { status: 400 });
  }

  const existing = await db.select().from(notificationChannels)
    .where(and(
      eq(notificationChannels.userId, userId),
      eq(notificationChannels.type, "push" as never),
    ))
    .limit(10);

  // Find existing mobile push channel
  const mobileCh = existing.find((ch) => {
    const cfg = ch.config as { platform?: string };
    return cfg.platform === "mobile";
  });

  if (mobileCh) {
    await db.update(notificationChannels)
      .set({ config: { expoToken, platform: "mobile" }, isActive: true })
      .where(eq(notificationChannels.id, mobileCh.id));
  } else {
    await db.insert(notificationChannels).values({
      userId,
      type: "push" as never,
      config: { expoToken, platform: "mobile" },
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  return NextResponse.json({ ok: true });
}
