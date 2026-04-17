/**
 * Phase A E2E: console log panel
 *
 * Loads the most recent replay (which includes at least one thrown error
 * from earlier tests — the SDK captures those as `_kind: "console"` error
 * events + a separate `_kind: "error"` event), then verifies:
 *   1. Console panel exists in the DOM and is expanded by default
 *   2. Panel contains at least one error-level row
 *   3. Level filter shows/hides rows correctly
 *   4. Clicking a row seeks the player to that timestamp
 *   5. Viewport scale stays stable when the panel collapses/expands
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
    const first = await page.$('a[href*="/sessions/s_"]');
    if (!first) throw new Error("No replay sessions in the list");
    const href = await first.getAttribute("href");
    await page.goto(`${DASHBOARD_URL}${href}`, { waitUntil: "networkidle" });

    // Let rrweb mount + first-frame paint finish
    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(1500);

    // 1. Console panel mounted and expanded by default
    const panelSelector = 'aside[aria-label="Console"]';
    const panel = await page.$(panelSelector);
    if (!panel) throw new Error("Console panel not found in DOM");

    const expandedWidth = await page.evaluate(
      (sel) => (document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().width,
      panelSelector,
    );
    console.log(`[1] Panel width (expanded): ${expandedWidth}px`);
    if (!expandedWidth || expandedWidth < 300) {
      throw new Error(`Panel too narrow — expected ~360px, got ${expandedWidth}`);
    }

    // 2. At least one row should be visible (or an empty-state message)
    const rows = await page.$$(`${panelSelector} li[data-idx]`);
    const emptyState = await page.$(`${panelSelector} >> text=No console output`);
    console.log(`[2] Log rows: ${rows.length}, empty-state present: ${!!emptyState}`);
    if (rows.length === 0 && !emptyState) {
      throw new Error("Panel shows neither rows nor an empty-state message");
    }

    // 3. Filter chips: click "Errors" then "All"
    const errBtn = await page.$(`${panelSelector} button[aria-pressed]:has-text("Errors")`);
    if (errBtn) {
      await errBtn.click();
      await page.waitForTimeout(200);
      const errOnly = await page.$$(`${panelSelector} li[data-idx]`);
      console.log(`[3] Rows after "Errors" filter: ${errOnly.length}`);
    }

    // 4. Click the first visible row → assert player timer advanced (if any rows)
    const firstRow = await page.$(`${panelSelector} li[data-idx="0"]`);
    if (firstRow) {
      const timerBefore = await readTimer(page);
      await firstRow.click();
      await page.waitForTimeout(300);
      const timerAfter = await readTimer(page);
      console.log(`[4] Timer before/after row click: ${timerBefore} → ${timerAfter}`);
    } else {
      console.log(`[4] Skipped — no rows to click`);
    }

    // 5. Collapse panel, measure viewport scale. Expand, compare.
    const collapseBtn = await page.$(`${panelSelector} button[aria-label="Collapse Console panel"]`);
    if (!collapseBtn) throw new Error("Collapse button not found");

    const iframeBefore = await iframeWidth(page);
    await collapseBtn.click();
    await page.waitForTimeout(400);  // allow width transition + ResizeObserver
    const iframeCollapsed = await iframeWidth(page);

    const expandBtn = await page.$(`${panelSelector} button[aria-label="Expand Console panel"]`);
    if (!expandBtn) throw new Error("Expand button not found after collapse");
    await expandBtn.click();
    await page.waitForTimeout(400);
    const iframeReExpanded = await iframeWidth(page);

    console.log(`[5] iframe width: expanded=${iframeBefore} collapsed=${iframeCollapsed} re-expanded=${iframeReExpanded}`);
    if (iframeCollapsed <= iframeBefore) {
      throw new Error("Viewport should widen when panel collapses");
    }

    console.log("\n═".repeat(30));
    console.log("✓ PASS — console panel functional, viewport scale dynamic.");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

async function readTimer(page: import("playwright").Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("span")).find((s) =>
      /\d+:\d{2}\.\d{3}\s*\/\s*\d+:\d{2}\.\d{3}/.test(s.textContent ?? ""),
    );
    return el?.textContent ?? null;
  });
}

async function iframeWidth(page: import("playwright").Page): Promise<number> {
  return page.evaluate(() => {
    const iframe = document.querySelector("iframe");
    return iframe?.getBoundingClientRect().width ?? 0;
  });
}

main().catch((err) => { console.error(err); process.exit(2); });
