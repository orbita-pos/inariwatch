/**
 * Screenshot handler — runs Playwright (Chromium) in the worker process to
 * render a preview URL and return a PNG buffer.
 *
 * Why it lives here instead of in Vercel serverless:
 *   - Cold starts: a Vercel serverless cold-loading Chromium is 3-5s per
 *     shot; the worker keeps a browser instance warm across requests.
 *   - Bundle weight: @sparticuz/chromium adds ~50MB to the web deploy and
 *     pollutes the shared module cache of every serverless function.
 *   - Separation: the web app handles HTTP orchestration; heavy browser
 *     work belongs next to Docker, on a long-lived box with real RAM.
 *
 * Browser reuse:
 *   Launching Chromium takes ~1s. We keep a single Browser alive across
 *   invocations and create a fresh Context (isolated cookies/storage) per
 *   request. If the process is idle for IDLE_CLOSE_MS, we close it to
 *   return memory — the next request re-launches.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";

const IDLE_CLOSE_MS = 5 * 60_000;

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    // `--no-sandbox` is required when running as root inside systemd. The
    // worker already runs as root on the Hetzner box; the preview URL is
    // a trusted subdomain we control, so there's no attack surface gained
    // by the isolation we're bypassing.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (browser) {
      const b = browser;
      browser = null;
      await b.close().catch(() => {});
    }
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

export type ScreenshotOpts = {
  url: string;
  /** CSS viewport width in px. Default 1280 (standard desktop). */
  width?: number;
  /** CSS viewport height in px. Default 800. */
  height?: number;
  /** Capture full page (scrolls beyond viewport) or just the viewport. */
  fullPage?: boolean;
  /** Hard timeout for the whole operation. Default 30s. */
  timeoutMs?: number;
};

export type ScreenshotResult = {
  png: Buffer;
  width: number;
  height: number;
};

/**
 * Render the given URL and return a PNG buffer.
 *
 * Race any page error / navigation failure against the overall timeout so
 * a misbehaving preview (infinite redirect, hung JS) can't wedge the
 * worker. `networkidle` is intentionally skipped — many apps stream data
 * continuously and never reach idle; we wait for `domcontentloaded` plus
 * a 1s settle, which reliably captures the above-the-fold hero that shows
 * the fix.
 */
export async function takeScreenshot(opts: ScreenshotOpts): Promise<ScreenshotResult> {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fullPage = opts.fullPage ?? false;

  // Retry wrapper for transient navigation failures. Preview Fix fires a
  // capture the instant Tier 1 transitions to `running`, which is often a
  // few seconds BEFORE Caddy's ACME issuer has finished provisioning the
  // TLS cert for the new preview-<id>.staging.inariwatch.com subdomain.
  // First hit then returns ERR_SSL_PROTOCOL_ERROR; a 3s backoff is plenty
  // for the cert to settle.
  const MAX_ATTEMPTS = 4;
  const TRANSIENT_NET_REGEX =
    /net::ERR_(SSL_PROTOCOL_ERROR|CONNECTION_REFUSED|CONNECTION_RESET|TIMED_OUT|EMPTY_RESPONSE|NAME_NOT_RESOLVED)/i;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const b = await getBrowser();
    let ctx: BrowserContext | null = null;
    try {
      ctx = await b.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        userAgent: "Mozilla/5.0 (InariWatch-Preview-Screenshot/1.0)",
        ignoreHTTPSErrors: true,
      });
      const page = await ctx.newPage();

      await page.goto(opts.url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      // Let React hydrate + any above-the-fold images decode. 1s is enough
      // for static/SSR apps; SPAs with heavy client-side fetching will
      // look slightly incomplete, which is acceptable for a hero shot.
      await page.waitForTimeout(1000);

      const png = await page.screenshot({
        type: "png",
        fullPage,
        timeout: timeoutMs,
      });

      return { png, width, height };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = TRANSIENT_NET_REGEX.test(msg);
      if (!transient || attempt === MAX_ATTEMPTS) break;
      // Backoff: 3s, 6s, 9s — up to ~18s total, well under the 30s
      // budget most callers give us via WORKER_TIMEOUT_MS.
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }

  scheduleIdleClose();
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
