import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Show current state of a preview_session (live/prediction status + Hetzner
 * deploy details) for local debugging.
 *
 * Usage: npx tsx scripts/preview-status.ts <alertId|slug|previewId>
 */
async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error("Usage: npx tsx scripts/preview-status.ts <alertId|slug|previewId>");
    process.exit(1);
  }

  const { db, previewSessions } = await import("../lib/db");
  const { eq } = await import("drizzle-orm");

  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const column = isUuid
    ? previewSessions.id
    : previewSessions.publicSlug;

  let rows = await db.select().from(previewSessions).where(eq(column, key));
  if (rows.length === 0 && isUuid) {
    // Might be an alertId instead of previewId.
    rows = await db
      .select()
      .from(previewSessions)
      .where(eq(previewSessions.alertId, key));
  }

  if (rows.length === 0) {
    console.log(`No preview_sessions match ${key}`);
    process.exit(0);
  }

  for (const r of rows) {
    console.log("—".repeat(60));
    console.log(`id:             ${r.id}`);
    console.log(`slug:           ${r.publicSlug}`);
    console.log(`alertId:        ${r.alertId.slice(0, 8)}…`);
    console.log(`liveStatus:     ${r.liveStatus}`);
    console.log(`liveDeployId:   ${r.liveDeployId ?? "(none)"}`);
    console.log(`liveUrl:        ${r.liveUrl ?? "(none)"}`);
    console.log(`liveHostname:   ${r.liveHostname ?? "(none)"}`);
    console.log(`liveError:      ${r.liveError ?? "(none)"}`);
    console.log(`liveStartedAt:  ${r.liveStartedAt?.toISOString() ?? "(none)"}`);
    console.log(`liveReadyAt:    ${r.liveReadyAt?.toISOString() ?? "(none)"}`);
    console.log(`liveExpiresAt:  ${r.liveExpiresAt?.toISOString() ?? "(none)"}`);
    const logsPreview = r.liveBuildLogs
      ? r.liveBuildLogs.length > 800
        ? r.liveBuildLogs.slice(-800) + "\n[... last 800 chars]"
        : r.liveBuildLogs
      : "(empty)";
    console.log(`liveBuildLogs:\n${logsPreview}`);
    console.log();
    console.log(`predictionStatus: ${r.predictionStatus}`);
    console.log(`predictionError:  ${r.predictionError ?? "(none)"}`);
    console.log(`predictionDurationMs: ${r.predictionDurationMs ?? "(none)"}`);
    console.log(`predictionCents:  ${r.predictionCents ?? "(none)"}`);
    console.log();
    console.log(`screenshotUrl:    ${r.screenshotUrl ?? "(none)"}`);
    console.log(`screenshotTakenAt:${r.screenshotTakenAt?.toISOString() ?? "(none)"}`);
    console.log(`screenshotSize:   ${r.screenshotWidth ?? "?"}x${r.screenshotHeight ?? "?"}`);
    console.log(`screenshotError:  ${r.screenshotError ?? "(none)"}`);
    console.log(`createdAt:        ${r.createdAt.toISOString()}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
