"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { detectProvider } from "@/lib/ai/client";
import { encrypt } from "@/lib/crypto";

export async function saveAIKey(
  rawKey: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated" };

  if (!rawKey.startsWith("sk-")) {
    return { error: "Key must start with sk- (Claude: sk-ant-…, OpenAI: sk-…)" };
  }

  // Quick validation — try a cheap API call
  const provider = detectProvider(rawKey);
  try {
    if (provider === "claude") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": rawKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.status === 401) return { error: "Invalid Claude API key." };
    } else {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      if (res.status === 401) return { error: "Invalid OpenAI API key." };
    }
  } catch {
    return { error: "Could not validate key — check your connection and try again." };
  }

  const service = provider === "claude" ? "claude" : "openai";

  // Upsert — remove old key for this provider, insert new one
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service)));

  await db.insert(apiKeys).values({
    userId,
    service,
    keyEncrypted: encrypt(rawKey),
  });

  revalidatePath("/settings");
  return {};
}

export async function deleteAIKey(): Promise<void> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return;

  await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        // Delete both Claude and OpenAI keys
        eq(apiKeys.service, "claude")
      )
    );

  await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.service, "openai")
      )
    );

  revalidatePath("/settings");
}
