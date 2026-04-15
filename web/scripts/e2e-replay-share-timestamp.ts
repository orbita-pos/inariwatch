/**
 * Phase I E2E: share at timestamp.
 *
 * Verifies:
 *   1. Player's URL gets ?t= synced to currentMs after first paint
 *   2. The Share button copies a URL containing ?t=<currentMs>
 *   3. Loading the player with ?t=<N> in the URL pre-seeks to that time
 */
import { chromium } from "playwright";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    const page = await context.newPage();

    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', "demo@inariwatch.com");
    await page.fill('input[type="password"]', "Demo1234!");
    await Promise.all([
      page.waitForURL(/\/(dashboard|alerts|replays|projects)/, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    await page.goto(`${DASHBOARD_URL}/replays`, { waitUntil: "networkidle" });
    const firstLink = await page.$('a[href*="/replays/s_"]');
    if (!firstLink) {
      console.log("[skip] No replay sessions");
      process.exit(0);
    }
    const href = await firstLink.getAttribute("href");
    const sid = href!.split("/").pop()!;

    // 1. Open player at t=0; verify ?t= appears once it advances
    await page.goto(`${DASHBOARD_URL}/replays/${sid}`, { waitUntil: "networkidle" });
    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Click the Play button to advance the time
    const playBtn = await page.$('button[aria-label="Play"]');
    if (playBtn) await playBtn.click();
    await page.waitForTimeout(2500);
    const pauseBtn = await page.$('button[aria-label="Pause"]');
    if (pauseBtn) await pauseBtn.click();

    // The URL sync runs on a 1s debounce, so wait for it
    await page.waitForFunction(
      () => /[?&]t=\d+/.test(window.location.search),
      undefined,
      { timeout: 4000 },
    );
    const tFromUrl = await page.evaluate(() => {
      const m = window.location.search.match(/[?&]t=(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });
    if (tFromUrl <= 0) throw new Error("?t= did not sync after playback");
    console.log(`[1] URL synced ?t=${tFromUrl} after playback ✓`);

    // 2. Click Share, verify clipboard contains the URL with ?t=
    const shareBtn = await page.$('button[aria-label="Copy share link with current timestamp"]');
    if (!shareBtn) throw new Error("Share button missing");
    await shareBtn.click();
    await page.waitForTimeout(300);
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    if (!clipText.includes(`/replays/${sid}`)) {
      throw new Error(`clipboard missing replay path: ${clipText}`);
    }
    if (!clipText.match(/[?&]t=\d+/)) {
      throw new Error(`clipboard missing ?t=: ${clipText}`);
    }
    console.log(`[2] Share copied: ${clipText}`);

    // The button should briefly show "Copied"
    const copiedSpan = await page.$('button[aria-label="Copy share link with current timestamp"] >> text=Copied');
    if (!copiedSpan) throw new Error("'Copied' feedback not shown");
    console.log("[3] 'Copied' feedback shown ✓");

    // 3. Load player with ?t=5000 — verify it pre-seeks
    await page.goto(`${DASHBOARD_URL}/replays/${sid}?t=5000`, { waitUntil: "networkidle" });
    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(2000);

    const seekedTimer = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll("span")).find((s) =>
        /\d+:\d{2}\.\d{3}\s*\/\s*\d+:\d{2}\.\d{3}/.test(s.textContent ?? ""),
      );
      return el?.textContent ?? "";
    });
    // Extract the "current" side of "0:05.000 / 0:30.000"
    const currentMatch = seekedTimer.match(/(\d+):(\d{2})\.(\d{3})/);
    if (!currentMatch) throw new Error(`Could not parse timer: ${seekedTimer}`);
    const m = parseInt(currentMatch[1], 10);
    const s = parseInt(currentMatch[2], 10);
    const ms = parseInt(currentMatch[3], 10);
    const totalMs = m * 60_000 + s * 1000 + ms;
    if (totalMs < 4500 || totalMs > 5500) {
      throw new Error(`Pre-seek failed — wanted ~5000ms, got ${totalMs}ms (${seekedTimer})`);
    }
    console.log(`[4] ?t=5000 pre-seeked player to ${totalMs}ms ✓`);

    console.log("\n═".repeat(30));
    console.log("✓ PASS — share at timestamp functional.");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
