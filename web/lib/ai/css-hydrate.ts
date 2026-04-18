/**
 * CSS hydration — external stylesheet fetcher.
 *
 * rrweb's FullSnapshot captures inline `<style>` tags and attribute-based
 * styles but NOT the contents of `<link rel="stylesheet">` references.
 * When we serialize the snapshot for the AI preview pipeline, the resulting
 * HTML loads with broken styling unless we inline the external sheets.
 *
 * This module fetches those hrefs (with strict timeouts + byte caps + same-
 * origin / HTTPS-only policy) and returns them as CSS strings the caller
 * can wrap in `<style>…</style>` tags inside the sanitized iframe srcDoc.
 *
 * We explicitly do NOT handle @import recursion — one level of network is
 * the safety budget. Most modern Next.js apps bundle their CSS into a single
 * /_next/static/css/*.css file, so one level is usually enough.
 */

const MAX_BYTES_PER_SHEET = 50 * 1024; // 50 KB
const FETCH_TIMEOUT_MS = 2_000;

export type HydratedStylesheet = {
  href: string;
  css: string;
  /** "ok" | "oversize" | "timeout" | "http" | "error". Never throws — each
   *  sheet that fails is reported but does not block the overall hydrate. */
  status: "ok" | "oversize" | "timeout" | "http" | "error";
};

/**
 * Fetch up to N external stylesheets in parallel. Non-HTTPS + non-same-origin
 * URLs are skipped for SSRF safety — preview-fix cannot be allowed to GET
 * from `http://169.254.169.254/` for instance.
 */
export async function hydrateExternalStylesheets(
  hrefs: string[],
  opts: { baseUrl?: URL; maxSheets?: number } = {},
): Promise<HydratedStylesheet[]> {
  const maxSheets = opts.maxSheets ?? 6;
  const resolved = hrefs
    .slice(0, maxSheets)
    .map((href) => resolveUrl(href, opts.baseUrl))
    .filter((u): u is URL => u !== null);

  const results = await Promise.all(
    resolved.map((u) => fetchOne(u.toString())),
  );
  return results;
}

function resolveUrl(raw: string, base?: URL): URL | null {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Allow HTTPS freely; HTTP only for localhost / 127 (dev convenience).
    if (url.protocol === "http:") {
      const h = url.hostname;
      if (h !== "localhost" && !h.startsWith("127.")) return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function fetchOne(href: string): Promise<HydratedStylesheet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(href, {
      signal: controller.signal,
      headers: { accept: "text/css,*/*;q=0.1" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return { href, css: "", status: "http" };
    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BYTES_PER_SHEET) {
      return { href, css: "", status: "oversize" };
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (text.length > MAX_BYTES_PER_SHEET) {
        return { href, css: "", status: "oversize" };
      }
      return { href, css: text, status: "ok" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES_PER_SHEET) {
        await reader.cancel();
        return { href, css: "", status: "oversize" };
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return { href, css: new TextDecoder().decode(merged), status: "ok" };
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted")) return { href, css: "", status: "timeout" };
    return { href, css: "", status: "error" };
  }
}

/**
 * Merge serialized HTML with its hydrated stylesheets. Returns a complete
 * HTML document where all external CSS has been inlined as `<style>` tags
 * inside `<head>`.
 *
 * The caller is responsible for sanitization of the resulting HTML before
 * setting it as an iframe `srcDoc`.
 */
export function mergeStylesheetsIntoHtml(
  html: string,
  inline: string[],
  hydrated: HydratedStylesheet[],
): string {
  const styleTags: string[] = [];
  for (const css of inline) {
    if (css.trim()) styleTags.push(`<style>${css}</style>`);
  }
  for (const sheet of hydrated) {
    if (sheet.status === "ok" && sheet.css.trim()) {
      styleTags.push(`<style data-href="${escapeAttr(sheet.href)}">${sheet.css}</style>`);
    }
  }
  const bundle = styleTags.join("\n");

  // Inject before the closing </head> if it exists; else prepend to <body>;
  // else wrap with a minimal shell.
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${bundle}</head>`);
  }
  if (/<body\b/i.test(html)) {
    return html.replace(/<body\b/i, `<head>${bundle}</head><body`);
  }
  return `<!DOCTYPE html><html><head>${bundle}</head><body>${html}</body></html>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
