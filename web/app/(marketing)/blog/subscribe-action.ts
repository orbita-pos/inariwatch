"use server";

import { db, blogSubscribers } from "@/lib/db";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function subscribeToNewsletter(
  email: string
): Promise<{ error?: string; ok?: boolean; alreadySubscribed?: boolean }> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !isValidEmail(trimmed)) {
    return { error: "Please enter a valid email address." };
  }

  try {
    // Check if already subscribed
    const [existing] = await db
      .select({ id: blogSubscribers.id })
      .from(blogSubscribers)
      .where(eq(blogSubscribers.email, trimmed))
      .limit(1);

    if (existing) return { ok: true, alreadySubscribed: true };

    await db.insert(blogSubscribers).values({
      email: trimmed,
      unsubscribeToken: generateToken(),
    });

    return { ok: true };
  } catch {
    return { error: "Something went wrong. Please try again." };
  }
}
