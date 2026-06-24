import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Nuke rate-limit keys in Upstash so a developer who got throttled while
 * smoke-testing can retry immediately. Scans `rl:*` for the given
 * namespaces and deletes every match. Dev-only helper — do NOT run in
 * production except during a known migration / smoke window.
 *
 *   npx tsx scripts/unblock-rate-limits.ts                 # default set
 *   npx tsx scripts/unblock-rate-limits.ts register-ip     # one namespace
 *   npx tsx scripts/unblock-rate-limits.ts login register-ip register
 */
async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error("UPSTASH_REDIS_REST_URL / TOKEN missing from .env.local");
    process.exit(1);
  }

  const namespaces = process.argv.slice(2);
  const targets =
    namespaces.length > 0 ? namespaces : ["register-ip", "register", "login"];

  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  for (const ns of targets) {
    const pattern = `rl:${ns}:*`;
    console.log(`\n=== ${pattern} ===`);

    // Upstash SCAN — single pass is fine for dev dataset sizes.
    let cursor = "0";
    let total = 0;
    do {
      const scanRes = await fetch(`${url}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/100`, {
        headers: h,
      });
      if (!scanRes.ok) {
        console.error(`  SCAN failed: ${scanRes.status} ${await scanRes.text()}`);
        break;
      }
      const scanBody = (await scanRes.json()) as { result: [string, string[]] };
      cursor = scanBody.result[0];
      const keys = scanBody.result[1] ?? [];

      for (const k of keys) {
        const delRes = await fetch(`${url}/del/${encodeURIComponent(k)}`, {
          method: "POST",
          headers: h,
        });
        if (!delRes.ok) {
          console.log(`  FAIL ${k}: ${delRes.status}`);
        } else {
          console.log(`  DEL  ${k}`);
          total++;
        }
      }
    } while (cursor !== "0");

    console.log(`  → ${total} key${total === 1 ? "" : "s"} cleared`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
