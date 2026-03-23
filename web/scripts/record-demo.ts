/**
 * InariWatch — Demo recording script
 *
 * Records a ~60s product demo automatically using Playwright.
 * Output: scripts/demo-output/inariwatch-demo.webm
 *
 * Usage:
 *   1. Start the app:  npm run dev
 *   2. Run:            DEMO_EMAIL=you@email.com DEMO_PASSWORD=yourpass npx tsx scripts/record-demo.ts
 *
 * On Windows (PowerShell):
 *   $env:DEMO_EMAIL="you@email.com"; $env:DEMO_PASSWORD="yourpass"; npx tsx scripts/record-demo.ts
 *
 * Optional:
 *   DEMO_URL=https://inariwatch.com   (default: http://localhost:3000)
 */

import { chromium } from "playwright";
import path from "path";
import fs from "fs";

const BASE_URL  = process.env.DEMO_URL      ?? "http://localhost:3000";
const EMAIL     = process.env.DEMO_EMAIL    ?? "";
const PASSWORD  = process.env.DEMO_PASSWORD ?? "";

if (!EMAIL || !PASSWORD) {
  console.error("❌  DEMO_EMAIL and DEMO_PASSWORD are required.");
  console.error("    Example: DEMO_EMAIL=you@x.com DEMO_PASSWORD=pass npx tsx scripts/record-demo.ts");
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, "demo-output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("🦊 InariWatch demo recorder starting...");
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   User: ${EMAIL}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 40,
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
    // ── 1. Landing page ───────────────────────────────────────────────────
    console.log("📍 Scene 1: Landing page");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await wait(3000);

    // ── 2. Login ──────────────────────────────────────────────────────────
    console.log("📍 Scene 2: Login");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await wait(600);

    await page.fill('input[type="email"]', EMAIL);
    await wait(300);
    await page.fill('input[type="password"]', PASSWORD);
    await wait(300);
    await page.click('button[type="submit"]');

    // Dashboard can redirect to /onboarding if user has no projects yet
    await page.waitForURL(
      (url) => url.pathname.startsWith("/dashboard") || url.pathname.startsWith("/onboarding"),
      { timeout: 12000 }
    );
    await wait(2000);

    // If landed on onboarding, still record it briefly then move on
    if (page.url().includes("/onboarding")) {
      console.log("   ↳ No projects yet — showing onboarding screen");
      await wait(3000);
    }

    // ── 3. Dashboard overview ─────────────────────────────────────────────
    console.log("📍 Scene 3: Dashboard");
    if (!page.url().includes("/dashboard")) {
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    }
    // Wait for actual content to render before recording
    await page.waitForSelector("h1, main", { timeout: 10000 }).catch(() => {});
    await wait(3000);

    // ── 4. Alerts list ────────────────────────────────────────────────────
    console.log("📍 Scene 4: Alerts");
    await page.click('nav a[href="/alerts"]');
    await page.waitForURL("**/alerts", { timeout: 8000 });
    await wait(3000);

    // ── 5. Alert detail (if any exist) ────────────────────────────────────
    const firstAlert = page.locator('a[href^="/alerts/"]').first();
    const alertExists = await firstAlert.isVisible().catch(() => false);

    if (alertExists) {
      console.log("📍 Scene 5: Alert detail");
      await firstAlert.click();
      await page.waitForURL("**/alerts/**", { timeout: 8000 });
      // Wait for alert title and panels to render
      await page.waitForSelector("h1", { timeout: 10000 }).catch(() => {});
      await wait(3000);

      // Try to trigger AI analysis
      const analyzeBtn = page.locator("button", { hasText: /analyze|ask inari/i }).first();
      const hasAnalyze = await analyzeBtn.isVisible().catch(() => false);
      if (hasAnalyze) {
        console.log("   ↳ Triggering AI analysis");
        await analyzeBtn.click();
        await wait(5000);
      }
    } else {
      console.log("📍 Scene 5: (no alerts — skipping detail)");
    }

    // ── 6. Projects ───────────────────────────────────────────────────────
    console.log("📍 Scene 6: Projects");
    await page.click('nav a[href="/projects"]');
    await page.waitForURL("**/projects", { timeout: 8000 });
    await wait(3000);

    // Click into first project if exists
    const firstProject = page.locator('a[href^="/projects/"]').first();
    const projectExists = await firstProject.isVisible().catch(() => false);
    if (projectExists) {
      await firstProject.click();
      await wait(3000);
    }

    // ── 7. On-Call ────────────────────────────────────────────────────────
    console.log("📍 Scene 7: On-Call");
    await page.click('nav a[href="/on-call"]');
    await page.waitForURL("**/on-call", { timeout: 8000 });
    await wait(3000);

    // ── 8. Analytics ──────────────────────────────────────────────────────
    console.log("📍 Scene 8: Analytics");
    await page.click('nav a[href="/analytics"]');
    await page.waitForURL("**/analytics", { timeout: 8000 });
    await wait(3000);

    // ── 9. Ask Inari (chat) ───────────────────────────────────────────────
    console.log("📍 Scene 9: Ask Inari");
    await page.click('nav a[href="/chat"]');
    await page.waitForURL("**/chat", { timeout: 8000 });
    // Wait for chat UI to fully render (textarea or the Ask Inari heading)
    await page.waitForSelector('h2, textarea', { timeout: 10000 }).catch(() => {});
    await wait(3000);

    // ── 10. Final shot — dashboard ────────────────────────────────────────
    console.log("📍 Scene 10: Final shot");
    await page.click('nav a[href="/dashboard"]');
    await page.waitForURL("**/dashboard", { timeout: 8000 });
    await wait(3000);

  } catch (err) {
    console.error("❌ Error during recording:", err);
  }

  // Save video
  const video = await page.video();
  await context.close();
  await browser.close();

  if (video) {
    const savedPath = await video.path();
    const finalPath = path.join(OUTPUT_DIR, "inariwatch-demo.webm");
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(savedPath, finalPath);
    console.log("");
    console.log("✅ Demo recorded!");
    console.log(`   📹 Video: ${finalPath}`);
    console.log("");
    console.log("Next steps:");
    console.log("  • Convert to GIF for README:");
    console.log("    ffmpeg -i inariwatch-demo.webm -vf \"fps=15,scale=1200:-1\" demo.gif");
    console.log("  • Or convert online: ezgif.com");
    console.log("  • Upload .webm to Twitter, LinkedIn, Product Hunt");
  }
}

main();
