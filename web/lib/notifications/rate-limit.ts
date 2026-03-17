import { db, notificationLogs, notificationChannels, emailSuppressions } from "@/lib/db";
import { eq, and, gt, sql } from "drizzle-orm";

// ── Configurable limits ─────────────────────────────────────────────────────

const EMAIL_PER_USER_HOURLY = Number(process.env.EMAIL_RATE_LIMIT_HOURLY ?? 10);
const EMAIL_PER_USER_DAILY = Number(process.env.EMAIL_RATE_LIMIT_DAILY ?? 50);
const EMAIL_GLOBAL_DAILY = Number(process.env.EMAIL_RATE_LIMIT_GLOBAL_DAILY ?? 500);
const VERIFICATION_COOLDOWN_MS = 60 * 1000; // 1 minute

// Verification cooldowns stay in-memory (per-session, non-critical)
const verificationCooldowns = new Map<string, number>();

// ── Rate limit (fully DB-backed) ────────────────────────────────────────────

export async function checkEmailRateLimit(
  userId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // 1. Global daily cap — count ALL sent emails today across all channels
  const [globalResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notificationLogs)
    .where(
      and(
        eq(notificationLogs.status, "sent"),
        gt(notificationLogs.sentAt, oneDayAgo)
      )
    );

  if ((globalResult?.count ?? 0) >= EMAIL_GLOBAL_DAILY) {
    return { allowed: false, reason: "Global daily email limit reached." };
  }

  // 2. Per-user limits — find user's email channels, count their logs
  const emailChannels = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.type, "email")
      )
    );

  if (emailChannels.length === 0) return { allowed: true };

  for (const channel of emailChannels) {
    const [hourly] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notificationLogs)
      .where(
        and(
          eq(notificationLogs.channelId, channel.id),
          eq(notificationLogs.status, "sent"),
          gt(notificationLogs.sentAt, oneHourAgo)
        )
      );

    if ((hourly?.count ?? 0) >= EMAIL_PER_USER_HOURLY) {
      return { allowed: false, reason: `Hourly email limit reached (${EMAIL_PER_USER_HOURLY}/hr).` };
    }

    const [daily] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notificationLogs)
      .where(
        and(
          eq(notificationLogs.channelId, channel.id),
          eq(notificationLogs.status, "sent"),
          gt(notificationLogs.sentAt, oneDayAgo)
        )
      );

    if ((daily?.count ?? 0) >= EMAIL_PER_USER_DAILY) {
      return { allowed: false, reason: `Daily email limit reached (${EMAIL_PER_USER_DAILY}/day).` };
    }
  }

  return { allowed: true };
}

// ── Suppression list ────────────────────────────────────────────────────────

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const [entry] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, email.toLowerCase()))
    .limit(1);
  return !!entry;
}

export async function suppressEmail(
  email: string,
  reason: "bounce" | "complaint" | "unsubscribe"
): Promise<void> {
  const normalized = email.toLowerCase();
  // Upsert — ignore if already suppressed
  const [existing] = await db
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.email, normalized))
    .limit(1);

  if (!existing) {
    await db.insert(emailSuppressions).values({ email: normalized, reason });
  }
}

export async function unsuppressEmail(email: string): Promise<void> {
  await db
    .delete(emailSuppressions)
    .where(eq(emailSuppressions.email, email.toLowerCase()));
}

// ── Verification cooldown (in-memory is fine here) ──────────────────────────

export function checkVerificationCooldown(
  userId: string
): { allowed: boolean; retryInSeconds?: number } {
  const lastSent = verificationCooldowns.get(userId);
  if (lastSent) {
    const elapsed = Date.now() - lastSent;
    if (elapsed < VERIFICATION_COOLDOWN_MS) {
      return {
        allowed: false,
        retryInSeconds: Math.ceil((VERIFICATION_COOLDOWN_MS - elapsed) / 1000),
      };
    }
  }
  return { allowed: true };
}

export function trackVerificationSent(userId: string) {
  verificationCooldowns.set(userId, Date.now());
}
