"use server";

import crypto from "crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, outgoingWebhooks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { encrypt } from "@/lib/crypto";

export async function createWebhook(url: string, events: string[]) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  const rawSecret = crypto.randomBytes(32).toString("hex");

  await db.insert(outgoingWebhooks).values({
    userId,
    url,
    secret: encrypt(rawSecret),
    events,
    isActive: true,
  });

  revalidatePath("/settings");
}

export async function deleteWebhook(webhookId: string) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  await db
    .delete(outgoingWebhooks)
    .where(and(eq(outgoingWebhooks.id, webhookId), eq(outgoingWebhooks.userId, userId)));

  revalidatePath("/settings");
}
