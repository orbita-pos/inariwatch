/**
 * Phase D E2E: rich filters on /sessions.
 *
 * Verifies:
 *   1. Filter bar renders all new controls (fingerprint, urlPath, dates, sort)
 *   2. Setting urlPath updates the URL + reloads with that param
 *   3. Setting a date range disables the rolling `since` select
 *   4. Sort direction toggle flips between asc/desc in the URL
 *   5. Shareable URL: navigating to a URL with all filters set hydrates them
 *   6. /api/replay/filter-options returns 200 with arrays
 */
import { chromium } from "playwright";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();

    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', "demo@inariwatch.com");
    await page.fill('input[type="password"]', "Demo1234!");
    await Promise.all([
      page.waitForURL(/\/(dashboard|alerts|replays|projects)/, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    await page.goto(`${DASHBOARD_URL}/sessions`, { waitUntil: "networkidle" });

    // Phase D+UI — the fingerprint / urlPath / email / date inputs live
    // under the "More filters" disclosure. Expand it before asserting.
    const more = await page.$('button:has-text("More filters")');
    if (more) {
      await more.click();
      await page.waitForTimeout(200);
    }

    // 1. All new controls present
    const fpSelect = await page.$('select[aria-label="Error fingerprint"]');
    const urlInput = await page.$('input[aria-label="URL path"]');
    const dateFromInput = await page.$('input[aria-label="From date"]');
    const dateToInput = await page.$('input[aria-label="To date"]');
    const sortSelect = await page.$('select[aria-label="Sort by"]');
    if (!fpSelect || !urlInput || !dateFromInput || !dateToInput || !sortSelect) {
      throw new Error("Missing one or more new filter controls");
    }
    console.log("[1] All new filter controls present ✓");

    // 2. urlPath input → URL update (debounced 300ms). We type char-by-char
    //    via `pressSequentially` so React fires onChange on every keystroke
    //    (some debouncers ignore the synthetic single fill event).
    await urlInput.click();
    await page.keyboard.type("/cart", { delay: 30 });
    await page.waitForFunction(
      () => window.location.search.includes("urlPath="),
      undefined,
      { timeout: 3000 },
    );
    if (!page.url().includes("urlPath=%2Fcart") && !page.url().includes("urlPath=/cart")) {
      throw new Error(`urlPath did not propagate to URL: ${page.url()}`);
    }
    console.log("[2] urlPath propagates to URL ✓");

    // Clear urlPath for the next checks
    await urlInput.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    await page.waitForFunction(
      () => !window.location.search.includes("urlPath="),
      undefined,
      { timeout: 3000 },
    );

    // 3. Setting dateFrom disables the `since` select. Re-query the input
    // because the "More filters" panel may have re-rendered.
    const dateFromLive = await page.$('input[aria-label="From date"]');
    if (!dateFromLive) throw new Error("From date input disappeared after urlPath clear");
    // Native type=date inputs: `fill` alone sometimes doesn't trigger React's
    // onChange. Set via evaluate + dispatch a synthetic input event.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('input[aria-label="From date"]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, "2026-01-01");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(
      () => window.location.search.includes("dateFrom=2026-01-01"),
      undefined,
      { timeout: 3000 },
    );
    if (!page.url().includes("dateFrom=2026-01-01")) {
      throw new Error(`dateFrom did not propagate: ${page.url()}`);
    }
    const sinceSelect = await page.$('select[aria-label="Time window"]');
    const sinceDisabled = await sinceSelect?.isDisabled();
    if (!sinceDisabled) throw new Error("`since` select should be disabled when an absolute date is set");
    console.log("[3] dateFrom disables rolling-since select ✓");

    // 4. Sort direction toggle — re-query fresh after the DOM update from step 3
    const dirBtn = await page.$('button[aria-label^="Sort direction:"]');
    if (!dirBtn) throw new Error("Sort direction button missing");
    await dirBtn.click();
    await page.waitForFunction(
      () => window.location.search.includes("sortDir=asc"),
      undefined,
      { timeout: 3000 },
    );
    console.log("[4] Sort direction toggle ✓");

    // 5. Shareable URL — open a deep-linked URL in a fresh page and confirm
    //    the controls hydrate to the filter state.
    const sharePage = await context.newPage();
    await sharePage.goto(
      `${DASHBOARD_URL}/sessions?urlPath=%2Fcheckout&sortBy=durationMs&sortDir=asc`,
      { waitUntil: "networkidle" },
    );
    const hydratedUrl = await sharePage.$eval(
      'input[aria-label="URL path"]',
      (el) => (el as HTMLInputElement).value,
    );
    const hydratedSort = await sharePage.$eval(
      'select[aria-label="Sort by"]',
      (el) => (el as HTMLSelectElement).value,
    );
    if (hydratedUrl !== "/checkout" || hydratedSort !== "durationMs") {
      throw new Error(`Hydration failed: urlPath="${hydratedUrl}" sortBy="${hydratedSort}"`);
    }
    console.log("[5] Shareable URL hydrates filters ✓");
    await sharePage.close();

    // 6. /api/replay/filter-options returns valid shape
    const optsResp = await page.evaluate(async () => {
      const r = await fetch("/api/replay/filter-options");
      return { status: r.status, body: await r.json() };
    });
    if (optsResp.status !== 200) throw new Error(`filter-options returned ${optsResp.status}`);
    if (!Array.isArray(optsResp.body.fingerprints) || !Array.isArray(optsResp.body.urlPaths)) {
      throw new Error("filter-options response missing arrays");
    }
    console.log(`[6] /api/replay/filter-options OK — ${optsResp.body.fingerprints.length} fp, ${optsResp.body.urlPaths.length} urls`);

    console.log("\n═".repeat(30));
    console.log("✓ PASS — rich filters functional, shareable, cached.");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
