/**
 * E2E: verifies the "Replays" nav link is hidden in personal mode
 * (no active workspace) even when REPLAY_V2_ORGS=* is set — and shows
 * up again after switching to BERNAL ORG.
 */
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";
const DEMO_USER_ID = "0a91bc32-b649-490c-a16e-9dea26f2113d";
const BERNAL_ORG_ID = "f4b0ed46-aab2-4d2b-aa0d-e8c0ae37f5f7";

async function setActiveOrg(value: string | null) {
  const sql = neon(readFileSync(".env.local", "utf-8").match(/^DATABASE_URL="?([^"\n]+)"?$/m)![1]);
  if (value === null) {
    await sql`UPDATE users SET active_org_id = NULL WHERE id = ${DEMO_USER_ID}`;
  } else {
    await sql`UPDATE users SET active_org_id = ${value} WHERE id = ${DEMO_USER_ID}`;
  }
}

async function replaysLinkVisible(page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("nav a"));
    return links.some((a) => a.getAttribute("href") === "/replays");
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    // --- Phase 1: personal mode (active_org_id = NULL) ---
    await setActiveOrg(null);
    console.log("Phase 1: active_org_id = NULL (personal mode)");

    const page = await context.newPage();
    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', "demo@inariwatch.com");
    await page.fill('input[type="password"]', "Demo1234!");
    await Promise.all([
      page.waitForURL(/\/(dashboard|alerts|projects)/, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    const personalVisible = await replaysLinkVisible(page);
    console.log(`  Replays link in sidebar: ${personalVisible ? "VISIBLE (bug)" : "hidden ✓"}`);

    // --- Phase 2: switch to BERNAL ORG ---
    await setActiveOrg(BERNAL_ORG_ID);
    console.log("\nPhase 2: active_org_id = BERNAL ORG");
    await page.reload({ waitUntil: "networkidle" });

    const orgVisible = await replaysLinkVisible(page);
    console.log(`  Replays link in sidebar: ${orgVisible ? "visible ✓" : "HIDDEN (bug)"}`);

    console.log("\n" + "═".repeat(50));
    const ok = !personalVisible && orgVisible;
    if (ok) {
      console.log("✓ PASS — nav gating is correct.");
      process.exit(0);
    } else {
      console.log("✗ FAIL — nav gating broken.");
      process.exit(1);
    }
  } finally {
    // Always restore active_org_id so the user's dashboard isn't left
    // in personal mode accidentally.
    await setActiveOrg(BERNAL_ORG_ID);
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
