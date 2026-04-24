import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Hit the exact same rateLimit() code path the /register action uses,
 * against the live Upstash, to see what it returns. If .success is
 * false here we know the library is rejecting us even though no key
 * visibly exists.
 */
async function main() {
  const { rateLimit } = await import("../lib/auth-rate-limit.js").catch(async () => {
    // Dist path may not exist — import TS source via tsx's resolver
    return import("../lib/auth-rate-limit");
  });

  const testIp = process.argv[2] ?? "10.0.0.1";
  const testEmail = process.argv[3] ?? "probe@example.com";

  console.log(`=== probe with ip=${testIp}, email=${testEmail} ===\n`);

  for (const ns of [
    { namespace: "register-ip", key: testIp, windowMs: 24 * 60 * 60_000, max: 3 },
    { namespace: "register", key: testEmail, windowMs: 60 * 60_000, max: 5 },
    { namespace: "login", key: testEmail, windowMs: 15 * 60_000, max: 10 },
  ]) {
    const r = await rateLimit(ns.namespace, ns.key, { windowMs: ns.windowMs, max: ns.max });
    console.log(`${ns.namespace}:${ns.key} windowMs=${ns.windowMs} max=${ns.max} ->`, r);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
