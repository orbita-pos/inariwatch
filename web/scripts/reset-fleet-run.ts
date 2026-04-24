/**
 * Delete fleet_verification_runs for an alert so the next click on
 * "Verify across fleet" produces a fresh run.
 *
 * Usage: npx tsx --env-file=.env.local scripts/reset-fleet-run.ts <alertId>
 */
import { db } from "@/lib/db";
import { fleetVerificationRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const alertId = process.argv[2];
  if (!alertId) {
    console.error("Usage: reset-fleet-run.ts <alertId>");
    process.exit(1);
  }
  await db.delete(fleetVerificationRuns).where(eq(fleetVerificationRuns.alertId, alertId));
  console.log(`Deleted fleet runs for alert ${alertId}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
