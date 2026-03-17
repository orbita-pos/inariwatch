"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys, notificationChannels } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { verifyTelegramBot, detectChatId, sendTelegram } from "@/lib/notifications/telegram";
import { verifySlackWebhook } from "@/lib/notifications/slack";
import { sendVerificationEmail } from "@/lib/notifications/email";
import { checkVerificationCooldown, trackVerificationSent } from "@/lib/notifications/rate-limit";

// In-memory store for email verification codes (short-lived, resets on deploy)
const pendingEmailCodes = new Map<string, { code: string; email: string; expiresAt: number }>();

export async function generateDesktopToken(): Promise<{ token?: string; error?: string }> {
  const session = await getServerSession(authOptions);
  const userId  = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Revoke any existing desktop token first
  await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, "desktop")));

  // Generate a new random token
  const token = `rdr_${randomBytes(24).toString("hex")}`;

  await db.insert(apiKeys).values({
    userId,
    service:      "desktop",
    keyEncrypted: encrypt(token),
  });

  revalidatePath("/settings");
  return { token };
}

// ── Notification channels ─────────────────────────────────────────────────────

export async function connectTelegram(
  botToken: string,
  chatId?: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Validate the bot token
  const bot = await verifyTelegramBot(botToken);
  if (!bot.ok) return { error: bot.error ?? "Invalid bot token." };

  // Auto-detect chat_id if not provided
  let resolvedChatId = chatId;
  if (!resolvedChatId) {
    const detected = await detectChatId(botToken);
    if (!detected.chatId) return { error: detected.error ?? "Could not detect chat ID." };
    resolvedChatId = detected.chatId;
  }

  // Send test message
  const test = await sendTelegram(
    { bot_token: botToken, chat_id: resolvedChatId },
    "\u{2705} <b>InariWatch connected!</b>\n\nYou'll receive alerts here when something needs your attention."
  );
  if (!test.ok) return { error: `Test message failed: ${test.error}` };

  // Upsert: replace existing Telegram channel for this user
  const [existing] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.type, "telegram")))
    .limit(1);

  const config = encryptConfig({ bot_token: botToken, chat_id: resolvedChatId, bot_name: bot.botName });

  if (existing) {
    await db
      .update(notificationChannels)
      .set({ config, isActive: true, verifiedAt: new Date() })
      .where(eq(notificationChannels.id, existing.id));
  } else {
    await db.insert(notificationChannels).values({
      userId,
      type: "telegram",
      config,
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  revalidatePath("/settings");
  return {};
}

export async function connectSlackChannel(
  webhookUrl: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
    return { error: "Invalid webhook URL. Must start with https://hooks.slack.com/" };
  }

  // Verify by sending a test message
  const test = await verifySlackWebhook(webhookUrl);
  if (!test.ok) return { error: `Test message failed: ${test.error}` };

  // Upsert: replace existing Slack channel for this user
  const [existing] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.type, "slack")))
    .limit(1);

  const config = encryptConfig({ webhook_url: webhookUrl });

  if (existing) {
    await db
      .update(notificationChannels)
      .set({ config, isActive: true, verifiedAt: new Date() })
      .where(eq(notificationChannels.id, existing.id));
  } else {
    await db.insert(notificationChannels).values({
      userId,
      type: "slack",
      config,
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  revalidatePath("/settings");
  return {};
}

export async function toggleChannel(
  channelId: string,
  isActive: boolean
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
    .limit(1);
  if (!channel) return { error: "Channel not found." };

  await db
    .update(notificationChannels)
    .set({ isActive })
    .where(eq(notificationChannels.id, channelId));

  revalidatePath("/settings");
  return {};
}

export async function deleteChannel(
  channelId: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
    .limit(1);
  if (!channel) return { error: "Channel not found." };

  await db.delete(notificationChannels).where(eq(notificationChannels.id, channelId));

  revalidatePath("/settings");
  return {};
}

// ── Severity filter ──────────────────────────────────────────────────────────

export async function updateChannelMinSeverity(
  channelId: string,
  minSeverity: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const validValues = ["info", "warning", "critical"];
  if (!validValues.includes(minSeverity)) {
    return { error: "Invalid severity value." };
  }

  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
    .limit(1);
  if (!channel) return { error: "Channel not found." };

  await db
    .update(notificationChannels)
    .set({ minSeverity })
    .where(eq(notificationChannels.id, channelId));

  revalidatePath("/settings");
  return {};
}

// ── Email notifications ───────────────────────────────────────────────────────

export async function sendEmailCode(
  email: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  if (!email || !email.includes("@")) return { error: "Invalid email address." };

  // Cooldown: 1 minute between verification emails
  const cooldown = checkVerificationCooldown(userId);
  if (!cooldown.allowed) {
    return { error: `Please wait ${cooldown.retryInSeconds}s before requesting another code.` };
  }

  // Generate 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));

  const result = await sendVerificationEmail(email, code);
  if (!result.ok) return { error: result.error ?? "Failed to send email." };

  trackVerificationSent(userId);

  // Store code for 10 minutes
  pendingEmailCodes.set(userId, {
    code,
    email,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return {};
}

export async function verifyEmailCode(
  code: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  const pending = pendingEmailCodes.get(userId);
  if (!pending) return { error: "No pending verification. Send a code first." };

  if (Date.now() > pending.expiresAt) {
    pendingEmailCodes.delete(userId);
    return { error: "Code expired. Please send a new one." };
  }

  if (pending.code !== code.trim()) return { error: "Invalid code." };

  // Code is valid — save the channel
  pendingEmailCodes.delete(userId);

  const [existing] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.type, "email")))
    .limit(1);

  const config = encryptConfig({ email: pending.email });

  if (existing) {
    await db
      .update(notificationChannels)
      .set({ config, isActive: true, verifiedAt: new Date() })
      .where(eq(notificationChannels.id, existing.id));
  } else {
    await db.insert(notificationChannels).values({
      userId,
      type: "email",
      config,
      isActive: true,
      verifiedAt: new Date(),
    });
  }

  revalidatePath("/settings");
  return {};
}
