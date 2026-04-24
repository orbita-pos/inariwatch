import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Dump every key in the configured Upstash namespace so we can find
 * unknown rate-limit shapes the per-namespace scanner misses.
 *
 *   npx tsx scripts/redis-scan-all.ts
 *   npx tsx scripts/redis-scan-all.ts "*register*"
 */
async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error("UPSTASH_REDIS_REST_URL / TOKEN missing from .env.local");
    process.exit(1);
  }
  const pattern = process.argv[2] ?? "*";
  const h = { Authorization: `Bearer ${token}` };

  let cursor = "0";
  const all: string[] = [];
  do {
    const res = await fetch(`${url}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/500`, { headers: h });
    const body = (await res.json()) as { result: [string, string[]] };
    cursor = body.result[0];
    all.push(...(body.result[1] ?? []));
  } while (cursor !== "0");

  console.log(`=== ${all.length} keys matching "${pattern}" ===`);
  for (const k of all.slice(0, 200)) console.log(`  ${k}`);
  if (all.length > 200) console.log(`  ... (+${all.length - 200} more)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
