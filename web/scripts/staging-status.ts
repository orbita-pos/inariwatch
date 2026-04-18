import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Query the Hetzner Go staging server directly for a given deploy's
 * status + build logs. Useful when Tier 1 is stuck in "building" and we
 * want to see what the container is actually doing.
 *
 * Usage: npx tsx scripts/staging-status.ts <deployId>
 */
async function main() {
  const deployId = process.argv[2];
  if (!deployId) {
    console.error("Usage: npx tsx scripts/staging-status.ts <deployId>");
    process.exit(1);
  }

  const url = process.env.STAGING_SERVER_URL;
  const secret = process.env.STAGING_API_SECRET;
  if (!url || !secret) {
    console.error("STAGING_SERVER_URL / STAGING_API_SECRET missing in .env.local");
    process.exit(1);
  }

  const res = await fetch(`${url.replace(/\/$/, "")}/status/${deployId}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });

  console.log(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    const { buildLogs, ...rest } = json;
    console.log(JSON.stringify(rest, null, 2));
    if (buildLogs) {
      console.log("\n── buildLogs (last 2000 chars) ──");
      console.log(buildLogs.length > 2000 ? buildLogs.slice(-2000) : buildLogs);
    }
  } catch {
    console.log(text);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
