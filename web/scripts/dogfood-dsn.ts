/**
 * Provision a dedicated InariWatch self-dogfood project + capture integration
 * and emit the plaintext DSN to paste into Kamal sops as INARIWATCH_DSN.
 *
 * - Idempotent: re-running on an existing dogfood project rotates the
 *   webhook secret. Existing alerts on that project are NOT touched.
 * - Encrypts webhook secret with ENCRYPTION_KEY before storing (matches
 *   loadIntegration() decrypt path in lib/webhooks/shared.ts).
 * - Plaintext is printed to stdout once and never persisted.
 */

import { db, users, projects, projectIntegrations } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

const DOGFOOD_SLUG = "inariwatch-prod";
const DOGFOOD_NAME = "InariWatch (production)";
const DOGFOOD_REPO = "orbita-pos/inariwatch";

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.error("ADMIN_EMAIL must be set in env");
    process.exit(1);
  }

  const [admin] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!admin) {
    console.error(`No user with email=${adminEmail}`);
    process.exit(1);
  }

  // Find or create dogfood project
  let [dogfoodProject] = await db.select().from(projects).where(eq(projects.slug, DOGFOOD_SLUG));
  if (!dogfoodProject) {
    [dogfoodProject] = await db.insert(projects).values({
      userId: admin.id,
      name: DOGFOOD_NAME,
      slug: DOGFOOD_SLUG,
      description: "Self-monitoring of app.inariwatch.com via @inariwatch/capture. Errors from the production Next.js server land here.",
      defaultRepo: DOGFOOD_REPO,
      visibility: "restricted",
    }).returning();
    console.log(`Created project: ${dogfoodProject.id} (${dogfoodProject.slug})`);
  } else {
    console.log(`Using existing project: ${dogfoodProject.id} (${dogfoodProject.slug})`);
  }

  // Find or rotate capture integration on dogfood project
  const [existing] = await db.select().from(projectIntegrations).where(
    and(
      eq(projectIntegrations.projectId, dogfoodProject.id),
      eq(projectIntegrations.service, "capture")
    )
  );

  // Generate fresh plaintext secret (32-byte hex = 64 chars).
  const plaintextSecret = crypto.randomBytes(32).toString("hex");
  const encryptedSecret = encrypt(plaintextSecret);

  let integrationId: string;
  if (existing) {
    await db.update(projectIntegrations)
      .set({ webhookSecret: encryptedSecret, isActive: true })
      .where(eq(projectIntegrations.id, existing.id));
    integrationId = existing.id;
    console.log(`Rotated secret on existing integration: ${integrationId}`);
  } else {
    const [created] = await db.insert(projectIntegrations).values({
      projectId: dogfoodProject.id,
      service: "capture",
      webhookSecret: encryptedSecret,
      isActive: true,
    }).returning();
    integrationId = created.id;
    console.log(`Created integration: ${integrationId}`);
  }

  const dsn = `https://${plaintextSecret}@app.inariwatch.com/capture/${integrationId}`;

  console.log("\n========================================================");
  console.log("INARIWATCH_DSN — paste this into sops + kamal env push:");
  console.log("========================================================\n");
  console.log(dsn);
  console.log("\n========================================================");
  console.log("Also recommended in Kamal env:");
  console.log("  INARIWATCH_REDACT=true");
  console.log("  INARIWATCH_RELEASE=$(git rev-parse --short HEAD)  # at build time");
  console.log("========================================================\n");

  console.log("Verification after deploy:");
  console.log(`  curl -i https://app.inariwatch.com/api/test/throw  # any 500 endpoint`);
  console.log(`  Then in DB:`);
  console.log(`    SELECT id, title, severity, created_at`);
  console.log(`    FROM alerts`);
  console.log(`    WHERE project_id = '${dogfoodProject.id}'`);
  console.log(`    ORDER BY created_at DESC LIMIT 5;`);
  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error("dogfood-dsn failed:", err);
  process.exit(1);
});
