/**
 * InariWatch — Demo recording script
 *
 * Records a 60-second product demo video automatically using Playwright.
 * Output: scripts/demo-output/demo.webm
 *
 * Usage:
 *   1. Make sure the app is running: npm run dev
 *   2. Run: npx ts-node scripts/record-demo.ts
 *      or:  npx tsx scripts/record-demo.ts
 *
 * Optional env vars:
 *   DEMO_URL=https://inariwatch.com   (default: http://localhost:3000)
 *   DEMO_EMAIL=you@example.com
 *   DEMO_PASSWORD=yourpassword
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const BASE_URL = process.env.DEMO_URL ?? "http://localhost:3000";
const EMAIL    = process.env.DEMO_EMAIL    ?? "";
const PASSWORD = process.env.DEMO_PASSWORD ?? "";

const OUTPUT_DIR = path.join(__dirname, "demo-output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("🦊 InariWatch demo recorder starting...");
  console.log(`   Recording against: ${BASE_URL}`);

  const browser = await chromium.launch({
    headless: false, // show the browser so you can see what's happening
    slowMo: 40,      // slow down actions so the video looks natural
    args: ["--window-size=1440,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();

  try {
    // ── 1. Landing page (3s) ──────────────────────────────────────────────
    console.log("📍 Scene 1: Landing page");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await wait(3000);

    // ── 2. Login (if credentials provided) ───────────────────────────────
    if (EMAIL && PASSWORD) {
      console.log("📍 Scene 2: Login");
      await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
      await wait(800);

      await page.fill('input[type="email"]', EMAIL);
      await wait(400);
      await page.fill('input[type="password"]', PASSWORD);
      await wait(400);
      await page.click('button[type="submit"]');
      await page.waitForURL("**/dashboard", { timeout: 10000 });
      await wait(1500);
    } else {
      // Go directly to dashboard if already logged in (session cookie)
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
      await wait(1500);
    }

    // ── 3. Dashboard overview (4s) ────────────────────────────────────────
    console.log("📍 Scene 3: Dashboard");
    await wait(4000);

    // ── 4. Navigate to Alerts (5s) ────────────────────────────────────────
    console.log("📍 Scene 4: Alerts");
    await page.click('a[href="/alerts"]');
    await page.waitForURL("**/alerts", { timeout: 8000 });
    await wait(3000);

    // Click the first alert if one exists
    const firstAlert = page.locator("table tbody tr, [data-alert]").first();
    const alertExists = await firstAlert.isVisible().catch(() => false);

    if (alertExists) {
      await firstAlert.click();
      await wait(3000);

      // ── 5. AI Analysis panel ───────────────────────────────────────────
      console.log("📍 Scene 5: AI Analysis");
      const analyzeBtn = page.locator("button", { hasText: /analyze|ask inari/i }).first();
      const hasAnalyze = await analyzeBtn.isVisible().catch(() => false);
      if (hasAnalyze) {
        await analyzeBtn.click();
        await wait(5000); // wait for AI response to stream in
      }
    }

    // ── 6. On-Call page (4s) ──────────────────────────────────────────────
    console.log("📍 Scene 6: On-Call");
    await page.click('a[href="/on-call"]');
    await page.waitForURL("**/on-call", { timeout: 8000 });
    await wait(4000);

    // ── 7. Projects page (3s) ─────────────────────────────────────────────
    console.log("📍 Scene 7: Projects");
    await page.click('a[href="/projects"]');
    await page.waitForURL("**/projects", { timeout: 8000 });
    await wait(3000);

    // Click into first project if exists
    const firstProject = page.locator("a[href^='/projects/']").first();
    const projectExists = await firstProject.isVisible().catch(() => false);
    if (projectExists) {
      await firstProject.click();
      await wait(3000);
    }

    // ── 8. Status page (4s) ───────────────────────────────────────────────
    console.log("📍 Scene 8: Public status page");
    await page.goto(`${BASE_URL}/status`, { waitUntil: "networkidle" }).catch(() => {});
    await wait(4000);

    // ── 9. Back to dashboard — final shot (3s) ────────────────────────────
    console.log("📍 Scene 9: Final shot");
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    await wait(3000);

  } catch (err) {
    console.error("Error during recording:", err);
  }

  // Save video
  const video = await page.video();
  await context.close();
  await browser.close();

  if (video) {
    const savedPath = await video.path();
    const finalPath = path.join(OUTPUT_DIR, "inariwatch-demo.webm");
    fs.renameSync(savedPath, finalPath);
    console.log("");
    console.log("✅ Demo recorded!");
    console.log(`   📹 Video saved to: ${finalPath}`);
    console.log("");
    console.log("Next steps:");
    console.log("  • Upload .webm directly to Twitter, LinkedIn, Product Hunt");
    console.log("  • Convert to GIF for README: ffmpeg -i inariwatch-demo.webm demo.gif");
    console.log("  • Or use ezgif.com to convert online (free)");
  }
}

main();
