/**
 * Prints the UUID + org for a project by slug. Useful when you need the
 * projectId for API calls (like /api/replay/ingest) but only know the slug.
 *
 * Usage: cd web && npx tsx scripts/show-project-id.ts <slug>
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const slug = process.argv[2] ?? "demo";
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) {
    console.error("DATABASE_URL not found in .env.local");
    process.exit(1);
  }
  const sql = neon(match[1]);

  const rows = await sql`
    SELECT p.id, p.slug, p.name, p.organization_id, o.name AS org_name
    FROM projects p
    LEFT JOIN organizations o ON o.id = p.organization_id
    WHERE p.slug = ${slug}
    LIMIT 1
  `;

  if (rows.length === 0) {
    console.error(`No project with slug="${slug}"`);
    process.exit(1);
  }

  const row = rows[0];
  console.log(`\n  projectId:      ${row.id}`);
  console.log(`  slug:           ${row.slug}`);
  console.log(`  name:           ${row.name}`);
  console.log(`  organizationId: ${row.organization_id ?? "(none — personal project)"}`);
  console.log(`  org name:       ${row.org_name ?? "(n/a)"}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
