import crypto from "crypto";
import { db, alerts, incidentStorms, projectIntegrations, projects, users, maintenanceWindows } from "@/lib/db";
import { eq, and, gt, lte, gte } from "drizzle-orm";
import { enqueueAlert } from "@/lib/notifications/send";
import { dispatchOutgoingWebhooks } from "@/lib/webhooks/outgoing";
import { autoCreateIncident } from "@/lib/ai/status-page-automation";
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
  const [row] = await db
    .select({
      integ: projectIntegrations,
      userPlan: users.plan,
    })
    .from(projectIntegrations)
    .innerJoin(projects, eq(projectIntegrations.projectId, projects.id))
    .innerJoin(users, eq(projects.userId, users.id))
    .where(
      and(
        eq(projectIntegrations.id, integrationId),
        eq(projectIntegrations.isActive, true)
      )
    )
    .limit(1);

  if (!row) return null;
  // Decrypt webhookSecret for signature verification
  return {
    ...row.integ,
    webhookSecret: row.integ.webhookSecret ? decrypt(row.integ.webhookSecret) : null,
    userPlan: row.userPlan,
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

  let stormId: string | null = null;
  let isTriggeringStorm = false;

  const [activeStorm] = await db
    .select({ id: incidentStorms.id })
    .from(incidentStorms)
    .where(
      and(
        eq(incidentStorms.projectId, projectId),
        eq(incidentStorms.status, "active")
      )
    )
    .limit(1);

  if (activeStorm) {
    stormId = activeStorm.id;
  } else {
    const stormWindow = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
    const recentAlerts = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.projectId, projectId),
          gt(alerts.createdAt, stormWindow)
        )
      )
      .limit(4);

    if (recentAlerts.length >= 4) {
      // This is the 5th alert in 5 minutes! Trigger storm
      const [newStorm] = await db
        .insert(incidentStorms)
        .values({ projectId, status: "active" })
        .returning();
      stormId = newStorm.id;
      isTriggeringStorm = true;
    }
  }

  const [inserted] = await db
    .insert(alerts)
    .values({ ...alert, projectId, stormId })
    .returning();

  // Only enqueue notification if this is a standard alert
  // OR if this specific alert is the one triggering the storm
  if (!stormId || isTriggeringStorm) {
    try {
      await enqueueAlert(inserted as Alert);
    } catch {
      // Non-blocking — alert is still saved
    }
  }

  try {
    await dispatchOutgoingWebhooks(inserted as Alert, "alert.created");
  } catch {
    // Non-blocking
  }

  // Auto-create status page incident for qualifying alerts
  try {
    await autoCreateIncident({
      projectId,
      alertId: inserted.id,
      alertTitle: inserted.title,
      alertSeverity: inserted.severity,
    });
  } catch {
    // Non-blocking — status page automation should never block alert creation
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
 *
 * Action links (ack/resolve) include a timestamp and expire after `ttlSec`.
 * Unsubscribe links omit the timestamp and never expire.
 */
export function signValue(value: string, ttlSec?: number): string {
  if (ttlSec) {
    const ts = Math.floor(Date.now() / 1000);
    const payload = `${value}:${ts}`;
    const sig = crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(payload)
      .digest("hex");
    return `${sig}:${ts}`;
  }
  return crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(value)
    .digest("hex");
}

/** Default TTL for action links (72 hours). */
export const ACTION_LINK_TTL = 72 * 60 * 60;

/**
 * Verify a signed value matches its token.
 * If the token contains a timestamp (format `sig:ts`), it also checks expiry.
 */
export function verifySignedValue(value: string, token: string, maxAgeSec?: number): boolean {
  if (!SIGNING_SECRET || !token) return false;

  // Check if token has timestamp component (sig:ts format)
  const colonIdx = token.lastIndexOf(":");
  if (colonIdx > 0 && maxAgeSec) {
    const sig = token.slice(0, colonIdx);
    const tsStr = token.slice(colonIdx + 1);
    const ts = Number(tsStr);
    if (!ts || isNaN(ts)) return false;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now - ts > maxAgeSec) return false;

    // Verify HMAC
    const payload = `${value}:${ts}`;
    const expected = crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(payload)
      .digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // Legacy: no timestamp
  const expected = crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(value)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}
