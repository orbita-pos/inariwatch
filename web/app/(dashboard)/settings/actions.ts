"use server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, apiKeys, notificationChannels, emailVerifications } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { randomBytes } from "crypto";
import { encrypt, encryptConfig } from "@/lib/crypto";
import { verifyTelegramBot, detectChatId, sendTelegram } from "@/lib/notifications/telegram";
import { verifySlackWebhook } from "@/lib/notifications/slack";
import { sendVerificationEmail } from "@/lib/notifications/email";
import { checkVerificationCooldown, trackVerificationSent } from "@/lib/notifications/rate-limit";
import { rateLimit } from "@/lib/auth-rate-limit";

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

  // Rate limit: max 5 code requests per 15 minutes per user
  const rl = await rateLimit("email-code", userId, { windowMs: 15 * 60_000, max: 5 });
  if (!rl.allowed) {
    return { error: `Too many attempts. Retry in ${rl.retryAfterSeconds}s.` };
  }

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

  // Delete any previous verification for this user
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.userId, userId));

  // Store code + email in DB (survives deploys)
  const tokenPayload = JSON.stringify({ code, email });
  await db.insert(emailVerifications).values({
    userId,
    token: tokenPayload,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  return {};
}

export async function verifyEmailCode(
  code: string
): Promise<{ error?: string }> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return { error: "Not authenticated." };

  // Rate limit: max 10 verify attempts per 15 minutes per user
  const rl = await rateLimit("email-verify", userId, { windowMs: 15 * 60_000, max: 10 });
  if (!rl.allowed) {
    return { error: `Too many attempts. Retry in ${rl.retryAfterSeconds}s.` };
  }

  // Look up pending verification from DB
  const [pending] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!pending) return { error: "No pending verification or code expired. Send a new code." };

  let storedCode: string;
  let storedEmail: string;
  try {
    const parsed = JSON.parse(pending.token);
    storedCode = parsed.code;
    storedEmail = parsed.email;
  } catch {
    return { error: "Invalid verification state. Send a new code." };
  }

  if (storedCode !== code.trim()) return { error: "Invalid code." };

  // Code is valid — clean up and save the channel
  await db
    .delete(emailVerifications)
    .where(eq(emailVerifications.userId, userId));

  const [existing] = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.type, "email")))
    .limit(1);

  const config = encryptConfig({ email: storedEmail });

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
