/**
 * Phase I.b E2E: keyboard shortcuts cheatsheet.
 *
 * Verifies:
 *   1. The "?" button in the controls bar opens the modal
 *   2. Pressing "?" anywhere on the page also opens the modal
 *   3. ESC closes it
 *   4. The cheatsheet enumerates the documented shortcuts
 */
import { chromium } from "playwright";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', "demo@inariwatch.com");
    await page.fill('input[type="password"]', "Demo1234!");
    await Promise.all([
      page.waitForURL(/\/(dashboard|alerts|replays|projects)/, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    await page.goto(`${DASHBOARD_URL}/replays`, { waitUntil: "networkidle" });
    const first = await page.$('a[href*="/replays/s_"]');
    if (!first) { console.log("[skip] no sessions"); process.exit(0); }
    const href = await first.getAttribute("href");
    await page.goto(`${DASHBOARD_URL}${href}`, { waitUntil: "networkidle" });
    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(1500);

    // 1. Click the ? button
    const helpBtn = await page.$('button[aria-label="Show keyboard shortcuts"]');
    if (!helpBtn) throw new Error("Shortcuts button missing");
    await helpBtn.click();
    await page.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { timeout: 2000 });
    console.log("[1] Modal opens via button ✓");

    // 4. Cheatsheet has the documented shortcuts
    const text = await page.$eval('[role="dialog"]', (el) => el.textContent ?? "");
    for (const expected of ["Play / pause", "Back / forward 1 second", "previous / next event", "Toggle this cheatsheet"]) {
      if (!text.includes(expected)) throw new Error(`Cheatsheet missing entry: "${expected}"`);
    }
    console.log("[2] Cheatsheet contents OK ✓");

    // 3. ESC closes
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const stillOpen = await page.$('[role="dialog"][aria-labelledby="shortcuts-title"]');
    if (stillOpen) throw new Error("ESC did not close the modal");
    console.log("[3] ESC closes ✓");

    // 2. Pressing ? on the page reopens
    await page.keyboard.press("?");
    await page.waitForSelector('[role="dialog"][aria-labelledby="shortcuts-title"]', { timeout: 2000 });
    console.log("[4] Pressing ? reopens ✓");

    // Backdrop click closes
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    const stillOpen2 = await page.$('[role="dialog"][aria-labelledby="shortcuts-title"]');
    if (stillOpen2) throw new Error("Backdrop click did not close the modal");
    console.log("[5] Backdrop click closes ✓");

    console.log("\n═".repeat(30));
    console.log("✓ PASS — keyboard shortcuts cheatsheet functional.");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
