import crypto from "crypto";
import { db, alerts, projectIntegrations, maintenanceWindows } from "@/lib/db";
import { eq, and, gt, lte, gte } from "drizzle-orm";
import { enqueueAlert } from "@/lib/notifications/send";
import { dispatchOutgoingWebhooks } from "@/lib/webhooks/outgoing";
import { decrypt } from "@/lib/crypto";
import type { NewAlert, Alert } from "@/lib/db";

/**
 * Verify HMAC signature.
 * GitHub uses sha256, Vercel uses sha1, Sentry uses sha256.
 */
export function verifySignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
  algorithm: "sha256" | "sha1" = "sha256"
): boolean {
  const expected = crypto
    .createHmac(algorithm, secret)
    .update(payload)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Load and validate an integration by ID.
 * Returns the integration row or null if not found / inactive.
 */
export async function loadIntegration(integrationId: string) {
  const [integ] = await db
    .select()
    .from(projectIntegrations)
    .where(
      and(
        eq(projectIntegrations.id, integrationId),
        eq(projectIntegrations.isActive, true)
      )
    )
    .limit(1);

  if (!integ) return null;
  // Decrypt webhookSecret for signature verification
  return {
    ...integ,
    webhookSecret: integ.webhookSecret ? decrypt(integ.webhookSecret) : null,
  };
}

/**
 * Insert an alert with 24h deduplication, then enqueue notifications.
 * Returns the inserted alert or null if it was a duplicate.
 */
export async function createAlertIfNew(
  alert: Omit<NewAlert, "projectId">,
  projectId: string
): Promise<Alert | null> {
  // Check if the project has an active maintenance window — if so, suppress the alert
  const now = new Date();
  const [activeMaintenance] = await db
    .select({ id: maintenanceWindows.id })
    .from(maintenanceWindows)
    .where(
      and(
        eq(maintenanceWindows.projectId, projectId),
        lte(maintenanceWindows.startsAt, now),
        gte(maintenanceWindows.endsAt, now)
      )
    )
    .limit(1);

  if (activeMaintenance) return null;

  const dedupeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [dup] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, projectId),
        eq(alerts.title, alert.title!),
        eq(alerts.isResolved, false),
        gt(alerts.createdAt, dedupeWindow)
      )
    )
    .limit(1);

  if (dup) return null;

  const [inserted] = await db
    .insert(alerts)
    .values({ ...alert, projectId })
    .returning();

  try {
    await enqueueAlert(inserted as Alert);
  } catch {
    // Non-blocking — alert is still saved
  }

  try {
    await dispatchOutgoingWebhooks(inserted as Alert, "alert.created");
  } catch {
    // Non-blocking
  }

  return inserted as Alert;
}

/**
 * Mark integration as successfully checked.
 */
export async function markIntegrationSuccess(integrationId: string) {
  await db
    .update(projectIntegrations)
    .set({ lastCheckedAt: new Date(), lastSuccessAt: new Date(), errorCount: 0 })
    .where(eq(projectIntegrations.id, integrationId));
}

/**
 * Generate a random webhook secret.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ── Signed URL tokens (for unsubscribe links) ──────────────────────────────

const SIGNING_SECRET = process.env.NEXTAUTH_SECRET ?? "";

/**
 * Create an HMAC-SHA256 signature for a given value.
 * Used to sign unsubscribe links so they can't be forged.
 */
export function signValue(value: string): string {
  return crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(value)
    .digest("hex");
}

/**
 * Verify a signed value matches its token.
 */
export function verifySignedValue(value: string, token: string): boolean {
  if (!SIGNING_SECRET || !token) return false;
  const expected = signValue(value);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}
