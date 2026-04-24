import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Clear the login rate-limit counter for an email.
 *
 *   npx tsx scripts/unblock-login.ts user@example.com
 *
 * The limiter keys every attempt under `rl:login:<lowercased-email>` in
 * Upstash. Deleting that key resets the 15-minute sliding window to zero
 * so the user can log in again immediately. No-op if the key isn't set.
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Usage: npx tsx scripts/unblock-login.ts <email>");
    process.exit(1);
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error("UPSTASH_REDIS_REST_URL / TOKEN missing from .env.local");
    process.exit(1);
  }

  // The Upstash rate-limit client stores keys as `<prefix>:<compositeKey>`
  // where prefix is "rl" and compositeKey is "login:<email>". So the full
  // key is `rl:login:<email>`.
  const key = `rl:login:${email}`;

  // Upstash REST: DEL via HTTP POST with the command in the URL path.
  const res = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`Upstash returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as { result: number };
  if (body.result === 1) {
    console.log(`OK — cleared ${key} (user can try again immediately)`);
  } else {
    console.log(`no key found at ${key} — either already cleared or window already rolled over`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
