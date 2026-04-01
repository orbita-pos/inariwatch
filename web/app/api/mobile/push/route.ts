import { NextRequest, NextResponse } from "next/server";
import { db, apiKeys, notificationChannels } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "@/lib/crypto";
import { timingSafeEqual } from "crypto";

async function authenticateMobile(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();

  const keys = await db.select().from(apiKeys).where(eq(apiKeys.service, "mobile"));
  for (const key of keys) {
    const decrypted = decrypt(key.keyEncrypted);
    if (decrypted.length === token.length) {
      const a = Buffer.from(decrypted);
      const b = Buffer.from(token);
      if (timingSafeEqual(a, b)) return key.userId;
    }
  }
  return null;
}

/**
 * POST /api/mobile/push/register
 * Body: { expoToken: "ExponentPushToken[xxx]" }
 */
export async function POST(req: NextRequest) {
  const userId = await authenticateMobile(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const expoToken = body.expoToken as string;

  if (!expoToken || !expoToken.startsWith("ExponentPushToken[")) {
    return NextResponse.json({ error: "Invalid Expo push token" }, { status: 400 });
  }

  // Upsert: check if already registered
  const existing = await db.select().from(notificationChannels)
    .where(and(
      eq(notificationChannels.userId, userId),
      eq(notificationChannels.type, "mobile_push" as never),
    ))
    .limit(1);

  if (existing.length > 0) {
    // Update token
    await db.update(notificationChannels)
      .set({ config: { expoToken }, isActive: true })
      .where(eq(notificationChannels.id, existing[0].id));
  } else {
    // Create new channel
    await db.insert(notificationChannels).values({
      userId,
      type: "push" as never, // reuse push type
      config: { expoToken, platform: "mobile" },
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  return NextResponse.json({ ok: true });
}
