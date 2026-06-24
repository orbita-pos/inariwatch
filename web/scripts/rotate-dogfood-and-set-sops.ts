/**
 * One-shot: rotate the dogfood capture integration's webhook secret in the
 * production DB and write the new DSN + INARIWATCH_REDACT directly into
 * web/.env.sops.yaml using `sops --set`. The plaintext secret never leaves
 * memory — no stdout, no chat, no temp file.
 *
 * Pre-req: SOPS_AGE_KEY_FILE pointing at your age private key (or the default
 * ~/.config/sops/age/keys.txt) so sops can re-encrypt the file.
 *
 * Run from web/:  npx tsx --env-file=.env.local scripts/rotate-dogfood-and-set-sops.ts
 */

import { db, users, projects, projectIntegrations } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { resolve } from "path";

const DOGFOOD_SLUG = "inariwatch-prod";
const SOPS_FILE = resolve(process.cwd(), ".env.sops.yaml");

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) throw new Error("ADMIN_EMAIL not set");

  const [admin] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!admin) throw new Error(`No user with email=${adminEmail}`);

  const [project] = await db.select().from(projects).where(eq(projects.slug, DOGFOOD_SLUG));
  if (!project) throw new Error(`No project with slug=${DOGFOOD_SLUG} — run dogfood-dsn.ts first`);

  const [integ] = await db.select().from(projectIntegrations).where(
    and(
      eq(projectIntegrations.projectId, project.id),
      eq(projectIntegrations.service, "capture")
    )
  );
  if (!integ) throw new Error(`No capture integration on project ${project.slug}`);

  const newPlaintext = crypto.randomBytes(32).toString("hex");
  const newEncrypted = encrypt(newPlaintext);

  await db.update(projectIntegrations)
    .set({ webhookSecret: newEncrypted, isActive: true })
    .where(eq(projectIntegrations.id, integ.id));

  const dsn = `https://${newPlaintext}@app.inariwatch.com/capture/${integ.id}`;

  // Write to sops via execFileSync — args array, no shell, no leakage.
  // sops --set syntax: '["KEY"] "value"' — value must be a quoted JSON string.
  const dsnJson = JSON.stringify(dsn);
  const redactJson = JSON.stringify("true");

  execFileSync("sops", ["--set", `["INARIWATCH_DSN"] ${dsnJson}`, SOPS_FILE], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  execFileSync("sops", ["--set", `["INARIWATCH_REDACT"] ${redactJson}`, SOPS_FILE], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  console.log(`✓ Rotated webhook secret on integration ${integ.id}`);
  console.log(`✓ Wrote INARIWATCH_DSN + INARIWATCH_REDACT to ${SOPS_FILE}`);
  console.log(`  (chat-leaked secret is now invalid — only the encrypted value in sops can decrypt)`);
  console.log();
  console.log("Verify with:");
  console.log("  sops -d --output-type dotenv .env.sops.yaml | grep -E 'INARIWATCH_(DSN|REDACT)'");
  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error("rotate-dogfood-and-set-sops failed:", err);
  process.exit(1);
});
