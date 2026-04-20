/**
 * Post-deploy image pre-warm (A4 — Vercel-level audit).
 *
 * `@vercel/og`-free sharp is fast but not free on a 2-vCPU Hetzner box. A
 * cold user hitting `/_next/image?url=%2Flogin-new-3.webp&w=1920&q=70` on
 * a viewport variant CF hasn't seen yet triggers sharp on the origin —
 * observed at 2–10 s per encode per variant.
 *
 * This script hits every (source × deviceSize × Accept header) combo once
 * immediately after deploy, so both the Next.js in-memory image cache
 * and the CF edge cache are warm before the first real user lands.
 *
 * Run locally:
 *   npx tsx scripts/prewarm-images.ts
 *
 * Run from CI (GitHub Actions, post-deploy step):
 *   BASE_URL=https://app.inariwatch.com npx tsx scripts/prewarm-images.ts
 *
 * Env:
 *   BASE_URL   — defaults to https://app.inariwatch.com
 *   SOURCES    — optional comma-sep override of /public paths to prewarm
 *   QUALITIES  — optional comma-sep override of quality values (default 70)
 */

const BASE_URL = process.env.BASE_URL ?? "https://app.inariwatch.com";
const DEVICE_SIZES = [640, 828, 1200, 1920] as const;
const FORMATS = [
  { accept: "image/avif", label: "avif" },
  { accept: "image/webp", label: "webp" },
] as const;

const SOURCES = (process.env.SOURCES ?? [
  "/login-new-3.webp",
  "/login-side-mobile.webp",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const QUALITIES = (process.env.QUALITIES ?? "70")
  .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));

interface Result {
  url: string;
  format: string;
  status: number;
  ttfbMs: number;
  cfCache: string | null;
  bytes: number | null;
}

async function prewarm(url: string, accept: string, label: string): Promise<Result> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: accept,
      "User-Agent": "InariWatch-Prewarm/1.0",
      // Identify ourselves so we never count as a real user in analytics.
      "x-prewarm": "1",
    },
    redirect: "follow",
  });

  // Drain body — required for the CF edge to finish caching, and for an
  // accurate byte count. We don't care about the pixels.
  const buf = await res.arrayBuffer();
  const ttfbMs = Date.now() - t0;

  return {
    url,
    format: label,
    status: res.status,
    ttfbMs,
    cfCache: res.headers.get("cf-cache-status"),
    bytes: buf.byteLength,
  };
}

async function main() {
  if (SOURCES.length === 0) {
    console.error("No sources to prewarm — set SOURCES env or restore defaults.");
    process.exit(1);
  }

  console.log(`[prewarm] base=${BASE_URL} sources=${SOURCES.length} variants=${DEVICE_SIZES.length * FORMATS.length * QUALITIES.length}`);

  const results: Result[] = [];
  for (const src of SOURCES) {
    for (const width of DEVICE_SIZES) {
      for (const q of QUALITIES) {
        const url = `${BASE_URL}/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${q}`;
        for (const fmt of FORMATS) {
          try {
            // Hit twice: first pass warms the origin, second confirms CF HIT.
            // The second response's cf-cache-status tells us whether CF
            // actually accepted and cached the variant.
            await prewarm(url, fmt.accept, fmt.label);
            const r = await prewarm(url, fmt.accept, fmt.label);
            results.push(r);
            console.log(
              `  [${r.status}] ${r.cfCache ?? "?".padEnd(8)}  ${r.format}  w=${width}  q=${q}  ${r.ttfbMs}ms  ${r.bytes}B  ${src}`,
            );
          } catch (err) {
            console.error(`  [ERR] ${fmt.label} w=${width} q=${q} ${src} — ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }
  }

  // Summary — useful in CI logs.
  const total = results.length;
  const hits = results.filter((r) => r.cfCache === "HIT").length;
  const misses = results.filter((r) => r.cfCache && r.cfCache !== "HIT").length;
  const errors = total - hits - misses;
  const okStatus = results.filter((r) => r.status === 200).length;

  console.log(`[prewarm] done — ${okStatus}/${total} 200-OK, cf-HIT=${hits} miss-or-other=${misses} errors=${errors}`);

  // Non-zero exit on any non-200 so CI surfaces the failure.
  if (okStatus !== total) {
    console.error("[prewarm] some variants did not return 200 — check next.config deviceSizes + /public paths.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[prewarm] fatal:", err);
  process.exit(1);
});
