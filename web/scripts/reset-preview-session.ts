import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Local-only reset utility for Preview Fix testing.
 *
 * Deletes the preview_sessions row for a given alertId so the next POST
 * /api/alerts/:id/preview creates a fresh row and re-kicks off both tiers.
 *
 * Usage:
 *   npx tsx scripts/reset-preview-session.ts <alertId>
 */
async function main() {
  const alertId = process.argv[2];
  if (!alertId) {
    console.error("Usage: npx tsx scripts/reset-preview-session.ts <alertId>");
    process.exit(1);
  }

  const { db, previewSessions, remediationSessions } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  const rows = await db
    .select({
      id: previewSessions.id,
      slug: previewSessions.publicSlug,
      liveStatus: previewSessions.liveStatus,
      predictionStatus: previewSessions.predictionStatus,
      remediationSessionId: previewSessions.remediationSessionId,
    })
    .from(previewSessions)
    .where(eq(previewSessions.alertId, alertId));

  if (rows.length === 0) {
    console.log(`No preview_sessions for alert ${alertId.slice(0, 8)}…`);
    process.exit(0);
  }

  console.log(`Found ${rows.length} preview_session(s) for alert ${alertId.slice(0, 8)}…:`);
  for (const r of rows) {
    console.log(`  ${r.id.slice(0, 8)}… slug=${r.slug} live=${r.liveStatus} prediction=${r.predictionStatus}`);
  }

  for (const r of rows) {
    await db
      .update(remediationSessions)
      .set({ previewSessionId: null, previewEnabledAt: null })
      .where(eq(remediationSessions.id, r.remediationSessionId));
  }

  const deleted = await db
    .delete(previewSessions)
    .where(eq(previewSessions.alertId, alertId))
    .returning({ id: previewSessions.id });

  console.log(`\nDeleted ${deleted.length} row(s). Refresh the alert page to trigger a fresh preview.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
