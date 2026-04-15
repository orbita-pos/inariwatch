/**
 * Tiny E2E: after clicking play, the player's visible time counter
 * should advance past 0:00.000 within ~1 second.
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

    await page.goto(`${DASHBOARD_URL}/replays`, { waitUntil: "networkidle" });
    const firstReplay = await page.$('a[href*="/replays/s_"]');
    if (!firstReplay) throw new Error("No replay sessions");
    const href = await firstReplay.getAttribute("href");
    await page.goto(`${DASHBOARD_URL}${href}`, { waitUntil: "networkidle" });

    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(1500);

    // The "XX:XX.XXX / XX:XX.XXX" timer span (format includes a slash)
    const readTimer = () =>
      page.evaluate(() => {
        const el = Array.from(document.querySelectorAll("span")).find((s) =>
          /\d+:\d{2}\.\d{3}\s*\/\s*\d+:\d{2}\.\d{3}/.test(s.textContent ?? ""),
        );
        return el?.textContent ?? null;
      });

    const timerBefore = await readTimer();
    console.log("Timer before play:", timerBefore);

    // Click play
    const playBtn = await page.$('button[aria-label="Play"]');
    if (playBtn) await playBtn.click();
    else await page.keyboard.press("Space");

    await page.waitForTimeout(2000);

    const timerAfter = await readTimer();
    console.log("Timer after 2s of play:", timerAfter);

    const beforeMs = parseTimer(timerBefore);
    const afterMs = parseTimer(timerAfter);
    const advanced = afterMs - beforeMs;
    console.log(`Advanced: ${advanced}ms`);

    if (advanced < 500) {
      console.log("✗ FAIL — timer didn't advance at least 500ms during 2s of playback.");
      process.exit(1);
    } else {
      console.log("✓ PASS — timer advanced correctly.");
      process.exit(0);
    }
  } finally {
    await browser.close();
  }
}

function parseTimer(text: string | null): number {
  if (!text) return 0;
  const m = text.match(/(\d+):(\d{2})\.(\d{3})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60_000 + parseInt(m[2], 10) * 1000 + parseInt(m[3], 10);
}

main().catch((err) => { console.error(err); process.exit(2); });
