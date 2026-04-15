/**
 * Lists organizations + their projects so we can pick one that's already
 * in a workspace for Replay V2 testing.
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const match = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!match) process.exit(1);
  const sql = neon(match[1]);

  const orgs = await sql`
    SELECT o.id, o.name, COUNT(p.id) AS project_count
    FROM organizations o
    LEFT JOIN projects p ON p.organization_id = o.id
    GROUP BY o.id, o.name
    ORDER BY o.name
  `;

  console.log(`\nOrganizations (${orgs.length}):`);
  for (const o of orgs) {
    console.log(`  - ${o.name}  (${o.id})  projects=${o.project_count}`);
  }

  const orgProjects = await sql`
    SELECT p.id, p.slug, p.name, o.name AS org_name
    FROM projects p
    INNER JOIN organizations o ON o.id = p.organization_id
    ORDER BY o.name, p.name
  `;

  console.log(`\nProjects inside workspaces (${orgProjects.length}):`);
  for (const p of orgProjects) {
    console.log(`  - [${p.org_name}] ${p.name} (slug=${p.slug})  id=${p.id}`);
  }

  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
