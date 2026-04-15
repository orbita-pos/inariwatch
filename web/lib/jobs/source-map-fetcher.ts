/**
 * Fetch + cache layer for source maps. Designed for the analyze worker:
 * many sessions, each with N stack frames pointing at a small set of
 * unique source URLs. Caching means the second session through this
 * worker rarely refetches anything.
 *
 * Cache layout:
 *   Redis key  `replay:srcmap:<sha256(url)>`  →  the raw .map text (24h TTL)
 *   Negative cache  same key + ":404"  →  "1" (1h TTL) when the .map URL
 *     returns 404 / network error. Saves us from refetching dead bundles
 *     hundreds of times per day.
 *
 * Why no R2 fallback yet: the median .map for a Next.js app is < 200KB —
 * fits comfortably in Redis without storage pressure. If we hit a customer
 * with multi-MB maps we'll add R2 as a tier; not worth the complexity now.
 */

import { createHash } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { isSafeUrl } from "@/lib/services/url-validation";

/** How long to remember a successfully fetched map. Bundles are immutable
 *  per-deploy; 24h gives us a healthy reuse window without going stale. */
const SUCCESS_TTL_SECONDS = 24 * 60 * 60;
/** Negative cache: don't hammer a 404 over and over. */
const NEGATIVE_TTL_SECONDS = 60 * 60;
/** Per-fetch timeout — slow CDN can't block the whole worker pass. */
const FETCH_TIMEOUT_MS = 3000;
/** Max .map size we'll keep — bigger than this, we still resolve once
 *  this run but don't pollute Redis with multi-MB blobs. */
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
/** Hard ceiling on the response we'll READ from the network at all.
 *  Without this, an attacker can point us at a 500MB gzip-bomb URL and
 *  OOM the worker before any size check runs. 4MB is generous for a
 *  legitimate Next.js / Vite production source map. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function cacheKey(url: string): string {
  const hash = createHash("sha256").update(url, "utf8").digest("hex");
  return `replay:srcmap:${hash}`;
}

/**
 * Resolve a JS bundle URL to its sourceMappingURL. Three lookup paths,
 * tried in order:
 *   1. `<url>.map` convention — works for ~95% of Next.js / Vite builds
 *   2. `//# sourceMappingURL=` comment in the JS itself (absolute URL only)
 *   3. Skip — caller falls back to raw frames
 *
 * We keep this string-matching lightweight; a "proper" parser would
 * download the .js too, which doubles fetch cost for marginal coverage.
 */
function guessMapUrl(jsUrl: string): string | null {
  if (!jsUrl) return null;
  // Strip any existing query string before appending .map
  const noQuery = jsUrl.split("?")[0];
  if (!noQuery.endsWith(".js")) return null;
  return `${noQuery}.map`;
}

interface FetchResult {
  raw: string | null;
  source: "cache" | "negative-cache" | "fetched" | "skipped";
}

async function fetchOne(jsUrl: string): Promise<FetchResult> {
  const mapUrl = guessMapUrl(jsUrl);
  if (!mapUrl) return { raw: null, source: "skipped" };

  // SSRF gate — `mapUrl` ultimately comes from a stack-frame `source`
  // string in user-submitted replay events. Without this check an
  // attacker could shape a stack frame pointing at IMDS / k8s API /
  // internal admin URLs and have the analyzer worker fetch them.
  // `isSafeUrl` blocks loopback, RFC1918, link-local (incl. 169.254),
  // ULA IPv6, .internal/.local TLDs, octal/decimal IP encodings.
  if (!isSafeUrl(mapUrl)) return { raw: null, source: "skipped" };

  const key = cacheKey(jsUrl);
  const negKey = `${key}:404`;
  const redis = getRedis();

  // 1. Cache hit?
  if (redis) {
    try {
      const cached = await redis.get<string>(key);
      if (cached) return { raw: cached, source: "cache" };
      const negative = await redis.get<string>(negKey);
      if (negative) return { raw: null, source: "negative-cache" };
    } catch {
      // Redis failure → silently fall through to fetch
    }
  }

  // 2. Live fetch with timeout + response-size ceiling.
  // Without the ceiling a 500MB gzip-bomb URL would OOM the worker BEFORE
  // any post-fetch size check runs. We check Content-Length up-front and
  // (when the server doesn't send one) stream chunks with a running
  // counter, aborting the request the moment we cross MAX_RESPONSE_BYTES.
  let text: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(mapUrl, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(timer);

    if (!resp.ok) {
      if (redis) {
        try { await redis.set(negKey, "1", { ex: NEGATIVE_TTL_SECONDS }); } catch { /* swallow */ }
      }
      return { raw: null, source: "negative-cache" };
    }

    // Up-front size guard via Content-Length when the server is honest.
    const declaredLen = parseInt(resp.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
      ctrl.abort();
      return { raw: null, source: "skipped" };
    }

    // Stream-and-cap path: handles servers that omit Content-Length and
    // keeps memory bounded even if the body lies about its size.
    const reader = resp.body?.getReader();
    if (!reader) {
      // No streaming body (very small responses) — fall back to .text() but
      // only after the Content-Length check above already gated us.
      text = await resp.text();
      if (text.length > MAX_RESPONSE_BYTES) text = null;
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            text = null;
            break;
          }
          chunks.push(value);
        }
      } finally {
        try { await reader.cancel(); } catch { /* already cancelled */ }
      }
      if (text !== null) {
        const all = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
        text = new TextDecoder("utf-8", { fatal: false }).decode(all);
      }
    }

    if (text === null) {
      // Oversized body — treat as "no map", negative-cache so we don't refetch
      if (redis) {
        try { await redis.set(negKey, "1", { ex: NEGATIVE_TTL_SECONDS }); } catch { /* swallow */ }
      }
      return { raw: null, source: "skipped" };
    }
  } catch {
    if (redis) {
      try { await redis.set(negKey, "1", { ex: NEGATIVE_TTL_SECONDS }); } catch { /* swallow */ }
    }
    return { raw: null, source: "negative-cache" };
  }

  // 3. Cache the win (skip if it's huge)
  if (redis && text.length <= MAX_CACHE_BYTES) {
    try {
      await redis.set(key, text, { ex: SUCCESS_TTL_SECONDS });
    } catch {
      // fine — we'll refetch next time
    }
  }

  return { raw: text, source: "fetched" };
}

/**
 * Resolve many JS URLs to their .map text in parallel, bounded by
 * `concurrency`. Returns a Map keyed by JS URL with null for any URL
 * we couldn't resolve (404, timeout, no .map convention match).
 *
 * Bounded concurrency matters here: a session with 30 unique URLs
 * shouldn't burst 30 simultaneous CDN requests against the customer's
 * deploy and look like a DoS.
 */
export async function fetchSourceMaps(
  jsUrls: string[],
  concurrency = 4,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const queue = Array.from(new Set(jsUrls)); // dedupe

  async function worker() {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      const { raw } = await fetchOne(url);
      out.set(url, raw);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
