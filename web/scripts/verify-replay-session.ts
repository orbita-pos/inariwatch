import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

async function main() {
  const env = readFileSync(".env.local", "utf-8");
  const m = env.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
  if (!m) process.exit(1);
  const sql = neon(m[1]);

  const sessions = await sql`
    SELECT session_id, block_count, total_bytes, click_selectors, r2_prefix, created_at
    FROM replay_sessions
    ORDER BY created_at DESC
    LIMIT 5
  `;
  console.log(`\nReplay sessions (${sessions.length}):`);
  for (const s of sessions) {
    console.log(`  ${s.session_id}`);
    console.log(`    blocks=${s.block_count} bytes=${s.total_bytes}`);
    console.log(`    click_selectors=${JSON.stringify(s.click_selectors)}`);
    console.log(`    r2_prefix=${s.r2_prefix}`);
    console.log(`    created=${s.created_at}\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
