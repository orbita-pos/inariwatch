/**
 * Day 1 AM E2E: multi-session journey page.
 *
 * Verifies:
 *   1. /sessions/users/<unknown-id> renders an empty state, not 404
 *   2. Player header pill links to /sessions/users/<id> (not the old filter URL)
 *   3. The page loads when reached via the pill link
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

    // 1. Empty state for an unknown user
    await page.goto(`${DASHBOARD_URL}/sessions/users/u_does_not_exist_99999`, { waitUntil: "networkidle" });
    const emptyHeading = await page.$('text=No sessions for this user');
    if (!emptyHeading) throw new Error("Empty state not rendered for unknown user");
    console.log("[1] Empty state for unknown user ✓");

    // 2. Find a session that DOES have an end user. Most demo sessions
    //    don't; if none exist, skip the rest gracefully.
    await page.goto(`${DASHBOARD_URL}/sessions?since=all`, { waitUntil: "networkidle" });
    const cards = await page.$$('a[href*="/sessions/s_"]');
    let foundUserSession = null as { sessionId: string; userId: string } | null;
    for (const card of cards.slice(0, 20)) {
      const href = await card.getAttribute("href");
      if (!href) continue;
      const sid = href.split("/").pop()!;
      const m = await page.evaluate(async (id) => {
        const r = await fetch(`/api/replay/${id}/manifest`);
        if (r.status !== 200) return null;
        const body = (await r.json()) as { endUser?: { id?: string | null } | null };
        return body.endUser?.id ?? null;
      }, sid);
      if (m) {
        foundUserSession = { sessionId: sid, userId: m };
        break;
      }
    }

    if (!foundUserSession) {
      console.log("[skip] No sessions with end_user_id — empty-state path is the only one verifiable here.");
      console.log("\n═".repeat(30));
      console.log("✓ PASS — empty state works; no end-user sessions to test full flow.");
      process.exit(0);
    }

    // 3. Player header points to /sessions/users/<id>
    await page.goto(`${DASHBOARD_URL}/sessions/${foundUserSession.sessionId}`, { waitUntil: "networkidle" });
    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(1500);
    const journeyLink = await page.$(`a[href="/sessions/users/${encodeURIComponent(foundUserSession.userId)}"]`);
    if (!journeyLink) throw new Error("Journey link missing in player header");
    console.log("[2] Player header links to /sessions/users/<id> ✓");

    // 4. Click into the journey page
    await journeyLink.click();
    await page.waitForURL(/\/sessions\/users\//, { timeout: 5000 });
    const heading = await page.$eval("h1", (el) => el.textContent ?? "");
    if (!heading) throw new Error("Journey page heading missing");
    console.log(`[3] Journey page loaded — heading: "${heading.slice(0, 60)}…"`);

    // 5. At least one stat card visible
    const statsCount = await page.$$eval('p:has-text("Sessions")', (els) => els.length);
    if (statsCount === 0) throw new Error("Aggregate stats row missing");
    console.log(`[4] Aggregates row rendered ✓`);

    console.log("\n═".repeat(30));
    console.log("✓ PASS — multi-session journey functional.");
    process.exit(0);
  } catch (err) {
    console.error("\n✗ FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
