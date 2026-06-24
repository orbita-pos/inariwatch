import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Cloudflare cache purge helper.
 *
 *   npx tsx scripts/cf-purge.ts <url> [<url> ...]   # purge specific URLs
 *   npx tsx scripts/cf-purge.ts everything          # purge_everything
 *
 * Reads from env:
 *   CLOUDFLARE_API_TOKEN   — token with Zone:Cache Purge:Edit on the zone
 *   CLOUDFLARE_ZONE_NAME   — defaults to inariwatch.com
 *   CLOUDFLARE_ZONE_ID     — optional; resolved from name when missing
 *
 * Designed to run from .env.local locally or from CI with CLOUDFLARE_API_TOKEN
 * exported as a GitHub secret. No values are echoed.
 *
 * Used by:
 *   - Local one-off invalidations after a hot fix that the automated purge
 *     step missed.
 *   - The "Purge Cloudflare cache" step in .github/workflows/deploy-web.yml,
 *     run after every successful kamal deploy so HTML pages with
 *     s-maxage=86400 don't keep serving the previous build for up to 24h.
 */

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? "inariwatch.com";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN missing — set it in .env.local or as a CI secret");
  process.exit(1);
}

const API = "https://api.cloudflare.com/client/v4";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ success: boolean; result: T; errors?: Array<{ message: string }> }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as {
    success: boolean;
    result: T;
    errors?: Array<{ message: string }>;
  };
  if (!body.success) {
    const msg = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`cf api ${path} failed: ${msg}`);
  }
  return body;
}

async function resolveZoneId(): Promise<string> {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  const r = await api<Array<{ id: string; name: string }>>(
    `/zones?name=${encodeURIComponent(ZONE_NAME)}`,
  );
  const zone = r.result[0];
  if (!zone) throw new Error(`zone ${ZONE_NAME} not found`);
  return zone.id;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "usage:\n" +
        "  cf-purge.ts <url> [<url> ...]\n" +
        "  cf-purge.ts everything",
    );
    process.exit(1);
  }

  const zoneId = await resolveZoneId();
  const everything = args[0] === "everything";
  const body = everything ? { purge_everything: true } : { files: args };

  await api(`/zones/${zoneId}/purge_cache`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (everything) {
    console.log(`purged everything on ${ZONE_NAME}`);
  } else {
    console.log(`purged ${args.length} url(s) on ${ZONE_NAME}:`);
    for (const u of args) console.log(`  ${u}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
