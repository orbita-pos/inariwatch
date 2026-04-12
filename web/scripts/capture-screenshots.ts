/**
 * InariWatch Dashboard Screenshot Capture
 *
 * Takes high-resolution @2x screenshots of the dashboard for the landing page.
 * Uses the demo account to capture real data.
 *
 * Usage:
 *   DEMO_URL=https://app.inariwatch.com DEMO_EMAIL=demo@inariwatch.com DEMO_PASSWORD=Demo1234! npx tsx web/scripts/capture-screenshots.ts
 *
 * Output:  web/public/screenshots/*.png
 * Convert: npx sharp-cli -i web/public/screenshots/*.png -o web/public/screenshots/ -f webp
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import * as path from "path";
import * as fs from "fs";

const BASE_URL = process.env.DEMO_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@inariwatch.com";
const PASSWORD = process.env.DEMO_PASSWORD || "Demo1234!";
const OUT_DIR = path.resolve(__dirname, "../public/screenshots");

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitForStable(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800);
  // Hide transient UI elements
  await page.evaluate(() => {
    document.querySelectorAll("[data-toast], [role='alert'], .Toastify").forEach((el) => (el as HTMLElement).style.display = "none");
  }).catch(() => {});
}

async function screenshot(page: Page, name: string) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, type: "png" });
  console.log(`  ✓ ${name}.png (${(fs.statSync(file).size / 1024).toFixed(0)}KB)`);
}

async function cropScreenshot(page: Page, selector: string, name: string) {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ timeout: 5000 });
    const file = path.join(OUT_DIR, `${name}-cropped.png`);
    await el.screenshot({ path: file, type: "png" });
    console.log(`  ✓ ${name}-cropped.png`);
  } catch {
    console.log(`  ⊘ ${name}-cropped.png (selector not found: ${selector})`);
  }
}

// ── Login ───────────────────────────────────────────────────────────────────

async function login(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  console.log("\n→ Logging in...");

  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);

  // Debug: capture what's on the page before clicking
  console.log(`  → Login page URL: ${page.url()}`);

  await page.click('button[type="submit"]');

  // Wait for either redirect or page change
  try {
    await page.waitForURL(/\/(dashboard|alerts|onboarding)/, { timeout: 30000 });
  } catch {
    // Maybe it redirected somewhere else or stayed on same page
    console.log(`  → After login URL: ${page.url()}`);
    const bodyText = await page.textContent("body").catch(() => "");
    console.log(`  → Page content preview: ${bodyText?.slice(0, 200)}`);

    // Try navigating directly to dashboard
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log(`  → Direct navigate URL: ${page.url()}`);
  }
  await waitForStable(page);
  console.log(`  ✓ Logged in → ${page.url()}`);

  return page;
}

// ── Capture Functions ───────────────────────────────────────────────────────

async function captureDashboard(page: Page) {
  console.log("\n→ Screenshot 3: Dashboard overview");
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await waitForStable(page);
  await screenshot(page, "dashboard-overview");
  // Crop: just the stats cards + recent alerts section
  await cropScreenshot(page, "main", "dashboard-overview");
}

async function captureAlertsList(page: Page) {
  console.log("\n→ Screenshot (prep): Alerts list");
  await page.goto(`${BASE_URL}/alerts`, { waitUntil: "domcontentloaded" });
  await waitForStable(page);
  // This is used to find a completed remediation
}

async function captureAlertDetail(page: Page): Promise<string | null> {
  console.log("\n→ Looking for an alert with remediation...");

  await page.goto(`${BASE_URL}/alerts`, { waitUntil: "domcontentloaded" });
  await waitForStable(page);

  // Click the first alert link to go to detail
  const alertLinks = page.locator('a[href^="/alerts/"]');
  const count = await alertLinks.count();

  if (count === 0) {
    console.log("  ⊘ No alerts found — skipping alert detail screenshots");
    return null;
  }

  // Try each alert — check for remediation content
  let bestAlertUrl: string | null = null;

  for (let i = 0; i < Math.min(count, 5); i++) {
    const href = await alertLinks.nth(i).getAttribute("href").catch(() => null);
    if (!href) break;

    await page.goto(`${BASE_URL}${href}`, { waitUntil: "domcontentloaded" });
    await waitForStable(page);

    // Look for ANY sign of remediation
    const hasRemediation = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return (
        text.includes("auto-merged") ||
        text.includes("completed") ||
        text.includes("merged") ||
        text.includes("pr #") ||
        text.includes("fix with ai") ||
        text.includes("security scan") ||
        text.includes("self-review") ||
        text.includes("confidence") ||
        text.includes("diagnos") ||
        text.includes("pushed branch")
      );
    });

    if (hasRemediation) {
      bestAlertUrl = page.url();
      console.log(`  ✓ Found remediation content at ${href}`);
      break;
    }

    console.log(`  ⊘ Alert ${i + 1} — no remediation content`);
    // Go back for next iteration
    await page.goto(`${BASE_URL}/alerts`, { waitUntil: "domcontentloaded" });
    await waitForStable(page);
  }

  if (!bestAlertUrl) {
    // Fallback: just use the first alert
    await page.goto(`${BASE_URL}/alerts`, { waitUntil: "domcontentloaded" });
    await waitForStable(page);
    const firstHref = await alertLinks.first().getAttribute("href").catch(() => null);
    if (firstHref) {
      bestAlertUrl = `${BASE_URL}${firstHref}`;
      await page.goto(bestAlertUrl, { waitUntil: "domcontentloaded" });
      await waitForStable(page);
      console.log(`  → Using first alert as fallback: ${firstHref}`);
    }
  }

  return bestAlertUrl;
}

async function capturePipelineComplete(page: Page, alertUrl: string) {
  console.log("\n→ Screenshot 1: Pipeline complete (alert detail)");
  await page.goto(alertUrl, { waitUntil: "domcontentloaded" });
  await waitForStable(page);
  await screenshot(page, "pipeline-complete");

  // Crop: remediation terminal section
  await cropScreenshot(page, ".font-mono", "pipeline-complete");
}

async function captureAutoMergeGates(page: Page, alertUrl: string) {
  console.log("\n→ Screenshot 2: Auto-merge gates");
  await page.goto(alertUrl, { waitUntil: "domcontentloaded" });
  await waitForStable(page);

  // Scroll to gates section if it exists
  const gatesSection = page.locator("text=/SAFETY GATES|safety gates|Gate/i").first();
  try {
    await gatesSection.scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(300);
  } catch { /* gates might be visible already */ }

  await screenshot(page, "auto-merge-gates");
  // Try to crop just the gates list
  await cropScreenshot(page, "text=/SAFETY GATES/i >> xpath=ancestor::div[contains(@class,'rounded')]", "auto-merge-gates");
}

async function capturePrGenerated(page: Page, alertUrl: string) {
  console.log("\n→ Screenshot 4: PR generated");
  await page.goto(alertUrl, { waitUntil: "domcontentloaded" });
  await waitForStable(page);

  // Scroll to PR section
  const prSection = page.locator("text=/Draft PR|Review.*PR|View.*PR|merged/i").first();
  try {
    await prSection.scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(300);
  } catch { /* PR section might be at the top */ }

  await screenshot(page, "pr-generated");
}

async function captureStagingVerification(page: Page, alertUrl: string) {
  console.log("\n→ Screenshot 5: Staging verification");
  await page.goto(alertUrl, { waitUntil: "domcontentloaded" });
  await waitForStable(page);

  // Look for staging-related content
  const stagingContent = page.locator("text=/staging|Staging|browser.*verification|visual.*analysis/i").first();
  const hasStagingContent = await stagingContent.count() > 0;

  if (hasStagingContent) {
    try {
      await stagingContent.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(300);
    } catch {}
    await screenshot(page, "staging-verification");
  } else {
    console.log("  ⊘ No staging verification content found — skipping");
  }
}

async function captureAnalytics(page: Page) {
  console.log("\n→ Screenshot (bonus): Analytics");
  await page.goto(`${BASE_URL}/analytics`, { waitUntil: "domcontentloaded" });
  await waitForStable(page);
  await screenshot(page, "analytics");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("InariWatch Screenshot Capture");
  console.log(`URL: ${BASE_URL}`);
  console.log(`Output: ${OUT_DIR}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  try {
    const page = await login(context);

    // Screenshot 3: Dashboard overview
    await captureDashboard(page);

    // Find the alert with seeded remediation, or fall back to search
    const SEEDED_ALERT_ID = "c9948422-a4d2-4750-9f98-d309fedb2c55";
    let alertUrl: string | null = null;

    // Try the seeded alert first
    console.log("\n→ Trying seeded alert with remediation...");
    await page.goto(`${BASE_URL}/alerts/${SEEDED_ALERT_ID}`, { waitUntil: "domcontentloaded" });
    await waitForStable(page);

    // Check if the page loaded (no error page)
    const hasError = await page.locator("text=/Something went wrong/i").count();
    if (hasError === 0) {
      alertUrl = page.url();
      console.log(`  ✓ Seeded alert loaded: ${alertUrl}`);
    } else {
      console.log("  ⊘ Seeded alert crashed — falling back to search");
      await captureAlertsList(page);
      alertUrl = await captureAlertDetail(page);
    }

    if (alertUrl) {
      // Screenshot 1: Pipeline complete
      await capturePipelineComplete(page, alertUrl);

      // Screenshot 2: Auto-merge gates
      await captureAutoMergeGates(page, alertUrl);

      // Screenshot 4: PR generated
      await capturePrGenerated(page, alertUrl);

      // Screenshot 5: Staging verification
      await captureStagingVerification(page, alertUrl);
    }

    // Bonus: Analytics
    await captureAnalytics(page);

    console.log("\n✓ Done. Screenshots saved to web/public/screenshots/");
    console.log("\nTo convert to WebP:");
    console.log("  npx sharp-cli -i web/public/screenshots/*.png -o web/public/screenshots/ -f webp -q 90");

  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err.message);
  process.exit(1);
});
