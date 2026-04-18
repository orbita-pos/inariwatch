/**
 * Preview Fix — session orchestration service.
 *
 * Owns the `preview_sessions` row lifecycle. Responsibilities:
 *
 *   1. Idempotent `getOrCreatePreviewSession` — POST /api/alerts/:id/preview
 *      calls this on every request. If a row exists for (alert, remediation)
 *      we return it unchanged; otherwise we allocate an unguessable
 *      public_slug, insert, write the back-pointer on remediation_sessions,
 *      and kick off both tiers as detached promises.
 *
 *   2. Public slug resolution — `getPreviewBySlug`. Powers the public
 *      `/preview/<slug>` page. Returns null on not-found OR revoked (the
 *      public endpoint returns 410 for revoked; the auth'd endpoint still
 *      resolves by id).
 *
 *   3. Engagement counters — `incrementPreviewViewCount` (public page load)
 *      and `incrementTierClickCount` (iframe interaction pings).
 *
 * Tier bootstrapping lives in sibling services:
 *   - `tier1-live.service.ts::kickoffTier1`
 *   - `tier3-predict.service.ts::kickoffTier3`
 *
 * This service never awaits either of them — they're fire-and-forget so the
 * POST response returns in <500ms regardless of Docker / Claude latency.
 */

import { randomBytes } from "node:crypto";
import {
  alerts,
  db,
  previewSessions,
  projects,
  remediationSessions,
  type PreviewSession,
} from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";

/** base32 alphabet (RFC 4648, no padding, no ambiguous chars). */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Generate a 12-char base32 slug (≈60 bits of entropy). Unguessable at any
 * realistic rate — there are ~10¹⁸ possibilities — while still fitting in
 * a tweet and being pronounceable.
 */
function generateSlug(): string {
  const bytes = randomBytes(8);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out.slice(0, 12);
}

export type CreatePreviewParams = {
  alertId: string;
  remediationSessionId: string;
  /** Used for audit logging + future per-user rate limits. */
  userId: string;
};

export type CreatePreviewResult =
  | {
      ok: true;
      created: boolean;
      session: PreviewSession;
    }
  | {
      ok: false;
      reason:
        | "remediation-not-found"
        | "remediation-not-completed"
        | "remediation-no-commit"
        | "alert-not-found";
    };

/**
 * Idempotent get-or-create. Returns `{ created: false }` if a row already
 * existed — the caller can use this to skip re-kickoff of the tiers.
 */
export async function getOrCreatePreviewSession(
  params: CreatePreviewParams,
): Promise<CreatePreviewResult> {
  // Fast path: existing row.
  const [existing] = await db
    .select()
    .from(previewSessions)
    .where(
      and(
        eq(previewSessions.alertId, params.alertId),
        eq(previewSessions.remediationSessionId, params.remediationSessionId),
      ),
    )
    .limit(1);

  if (existing) {
    return { ok: true, created: false, session: existing };
  }

  // Validate the referenced remediation + alert before inserting so a fresh
  // preview always corresponds to a real, completed, merged fix.
  const [remediation] = await db
    .select({
      id: remediationSessions.id,
      alertId: remediationSessions.alertId,
      status: remediationSessions.status,
      mergedCommitSha: remediationSessions.mergedCommitSha,
      projectId: remediationSessions.projectId,
      eapReceiptId: remediationSessions.eapReceiptId,
    })
    .from(remediationSessions)
    .where(eq(remediationSessions.id, params.remediationSessionId))
    .limit(1);

  if (!remediation) return { ok: false, reason: "remediation-not-found" };
  if (remediation.alertId !== params.alertId) {
    return { ok: false, reason: "alert-not-found" };
  }
  if (remediation.status !== "completed") {
    return { ok: false, reason: "remediation-not-completed" };
  }
  if (!remediation.mergedCommitSha) {
    return { ok: false, reason: "remediation-no-commit" };
  }

  const [alert] = await db
    .select({ id: alerts.id, projectId: alerts.projectId })
    .from(alerts)
    .where(eq(alerts.id, params.alertId))
    .limit(1);

  if (!alert) return { ok: false, reason: "alert-not-found" };

  const [project] = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, alert.projectId))
    .limit(1);

  // Allocate a unique slug. Retry up to 3 times on UNIQUE collision — with
  // 60-bit entropy and ≪10⁶ rows the collision probability is astronomically
  // low, but the retry loop makes that formal rather than hand-waved.
  let inserted: PreviewSession | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    const slug = generateSlug();
    try {
      const rows = await db
        .insert(previewSessions)
        .values({
          publicSlug: slug,
          alertId: params.alertId,
          projectId: alert.projectId,
          organizationId: project?.organizationId ?? null,
          remediationSessionId: params.remediationSessionId,
          eapReceiptId: remediation.eapReceiptId,
          // Tier 3 runs in-process from the POST handler (~2-3s) so it starts
          // in "rendering" rather than "pending". Tier 1 is always detached.
          predictionStatus: "pending",
          liveStatus: "pending",
        })
        .returning();
      inserted = rows[0];
    } catch (err) {
      lastError = err;
      // Distinguish slug collision from other unique-violation / FK errors.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("preview_sessions_public_slug_key")) {
        // A different constraint kicked in — likely the (alert_id,
        // remediation_session_id) unique, meaning someone raced us. Re-read
        // and return that row.
        if (msg.includes("preview_sessions_unique_per_remediation")) {
          const [raced] = await db
            .select()
            .from(previewSessions)
            .where(
              and(
                eq(previewSessions.alertId, params.alertId),
                eq(previewSessions.remediationSessionId, params.remediationSessionId),
              ),
            )
            .limit(1);
          if (raced) return { ok: true, created: false, session: raced };
        }
        throw err;
      }
    }
  }

  if (!inserted) {
    throw new Error(
      `failed to allocate unique preview slug after 3 attempts: ${String(lastError)}`,
    );
  }

  // Back-pointer on the remediation row so the alert detail page can render
  // the panel without a second query.
  await db
    .update(remediationSessions)
    .set({ previewSessionId: inserted.id, previewEnabledAt: new Date() })
    .where(eq(remediationSessions.id, params.remediationSessionId));

  return { ok: true, created: true, session: inserted };
}

/**
 * Public page lookup. Returns null on not-found. Returns the row even if
 * revoked — the caller decides what to do (public endpoint returns 410 with
 * a friendly page, internal queries still resolve).
 */
export async function getPreviewBySlug(
  slug: string,
): Promise<PreviewSession | null> {
  const [row] = await db
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.publicSlug, slug))
    .limit(1);
  return row ?? null;
}

export async function getPreviewById(id: string): Promise<PreviewSession | null> {
  const [row] = await db
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Atomic view-count bump. Uses SQL `+ 1` rather than read-modify-write so
 * concurrent views on a shared URL don't drop increments.
 */
export async function incrementPreviewViewCount(id: string): Promise<void> {
  await db
    .update(previewSessions)
    .set({ viewCount: sql`${previewSessions.viewCount} + 1` })
    .where(eq(previewSessions.id, id));
}

export async function incrementTierClickCount(
  id: string,
  tier: "live" | "predicted",
): Promise<void> {
  if (tier === "live") {
    await db
      .update(previewSessions)
      .set({ tier1ClickCount: sql`${previewSessions.tier1ClickCount} + 1` })
      .where(eq(previewSessions.id, id));
  } else {
    await db
      .update(previewSessions)
      .set({ tier3ClickCount: sql`${previewSessions.tier3ClickCount} + 1` })
      .where(eq(previewSessions.id, id));
  }
}

/**
 * Org-owner revoke flow. Sets `revoked_at` so the public endpoint returns
 * 410 Gone. The internal `getPreviewById` still returns the row — the row is
 * not deleted because remediation_sessions holds a FK to it.
 */
export async function revokePreviewSession(id: string): Promise<void> {
  await db
    .update(previewSessions)
    .set({ revokedAt: new Date() })
    .where(eq(previewSessions.id, id));
}
