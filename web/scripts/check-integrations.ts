import { config } from "dotenv";
import path from "path";
config({ path: path.join(__dirname, "../.env.local") });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const integs = await sql`SELECT service, COUNT(*)::int AS n FROM project_integrations GROUP BY service`;
  console.log("Integrations by service:", integs);

  const projs = await sql`SELECT id, name, user_id FROM projects ORDER BY created_at DESC LIMIT 20`;
  console.log("\nProjects (most recent 20):");
  for (const p of projs as { id: string; name: string; user_id: string }[]) {
    console.log(`  ${p.id.slice(0, 8)}…  ${p.name}`);
  }

  const githubIntegs = await sql`SELECT project_id, config_encrypted FROM project_integrations WHERE service = 'github'`;
  console.log(`\nGitHub integrations: ${githubIntegs.length}`);

  const { decryptConfig } = await import("../lib/crypto");
  for (const row of githubIntegs as { project_id: string; config_encrypted: string }[]) {
    try {
      const cfg = decryptConfig(row.config_encrypted);
      const redacted = { ...cfg, token: cfg.token ? "<redacted>" : undefined };
      console.log(`  project=${row.project_id.slice(0, 8)}`);
      console.log(`    ${JSON.stringify(redacted, null, 2).split("\n").join("\n    ")}`);
    } catch (e) {
      console.log(`  project=${row.project_id.slice(0, 8)}  decrypt_err: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
