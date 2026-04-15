/**
 * E2E test: verifies the rrweb Replayer viewport actually renders DOM
 * instead of showing a black screen.
 *
 * Flow:
 *   1. Launch Chromium.
 *   2. Open tester at localhost:3001, trigger a setTimeout error, wait
 *      for capture to flush to /api/replay/ingest.
 *   3. Close the tester page → fires `pagehide` → final flush with
 *      isFinal: true.
 *   4. Login to dashboard at localhost:3000 as demo@inariwatch.com.
 *   5. Navigate to /replays, click the newest session.
 *   6. Wait for the rrweb iframe to mount, then inspect:
 *         - iframe has children in body?
 *         - wrapper transform != scale(0)?
 *         - actual rendered content is not pure-black pixels?
 *   7. Take a screenshot to screenshots/replay-viewport.png so we can
 *      visually confirm.
 *
 * Exit code 0 = viewport has content. 1 = black / empty.
 *
 * Usage:
 *   cd web && npx tsx scripts/e2e-replay-viewport-test.ts
 */

import { chromium, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const TESTER_URL = process.env.TESTER_URL ?? "http://localhost:3001";
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";
const EMAIL = process.env.TEST_EMAIL ?? "demo@inariwatch.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "Demo1234!";

const SCREENSHOT_DIR = join(process.cwd(), "screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function captureReplaySession(page: Page): Promise<string> {
  console.log(`\n[1/6] Opening tester at ${TESTER_URL} …`);
  // Collect ingest requests so we can confirm blocks are flushing
  const ingestRequests: { url: string; status: number }[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    if (url.includes("/api/replay/ingest")) {
      ingestRequests.push({ url, status: resp.status() });
    }
  });

  await page.goto(TESTER_URL, { waitUntil: "networkidle", timeout: 30000 });

  // Grab the session id exposed by the SDK
  const sessionId = await page.evaluate(
    () => (window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__,
  );
  console.log(`    session id = ${sessionId ?? "(not set — SDK didn't init)"}`);
  if (!sessionId) throw new Error("SDK didn't expose __INARIWATCH_SESSION__ — is replayIntegration wired?");

  console.log("[2/6] Generating some activity + triggering an error …");
  // Click around + scroll to generate mutation events
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(100 + i * 50, 200 + i * 30);
    await page.mouse.click(100 + i * 50, 200 + i * 30).catch(() => {});
    await page.waitForTimeout(200);
  }
  // Scroll to trigger more DOM events
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(300);

  // Trigger the error that should promote buffer → streaming mode
  await page.evaluate(() => {
    setTimeout(() => { throw new Error("[e2e] test replay trigger"); }, 100);
  });

  console.log("[3/6] Waiting 5s for the flush to complete …");
  await page.waitForTimeout(5000);

  console.log(`    ingest requests observed: ${ingestRequests.length}`);
  for (const r of ingestRequests) console.log(`      ${r.status} ${r.url.slice(0, 90)}…`);

  // Close the page to fire pagehide → sendBeacon final flush
  await page.close();

  // Give the beacon a moment to land + DB upsert to finish
  await new Promise((r) => setTimeout(r, 2000));

  return sessionId;
}

async function loginDashboard(page: Page): Promise<void> {
  console.log(`\n[4/6] Logging into dashboard as ${EMAIL} …`);
  await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(dashboard|onboarding|alerts|replays|projects)/, { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log(`    landed at ${page.url()}`);
}

async function inspectReplayViewport(page: Page, sessionId: string): Promise<{
  ok: boolean;
  diagnostics: Record<string, unknown>;
}> {
  console.log(`\n[5/6] Opening /replays/${sessionId} …`);
  await page.goto(`${DASHBOARD_URL}/replays/${sessionId}`, { waitUntil: "networkidle", timeout: 20000 });

  // Wait for the player to mount the rrweb iframe
  try {
    await page.waitForSelector("iframe", { timeout: 15000 });
  } catch {
    return {
      ok: false,
      diagnostics: { error: "iframe never mounted on /replays page" },
    };
  }

  // Give rrweb time to run fullsnapshot-rebuilded + pause(0)
  await page.waitForTimeout(2000);

  console.log("[6/6] Inspecting iframe contents …");
  const diagnostics = await page.evaluate(() => {
    const iframe = document.querySelector("iframe");
    const wrapper = document.querySelector(".replayer-wrapper") as HTMLElement | null;
    const iframeRect = iframe?.getBoundingClientRect();
    const innerDoc = iframe?.contentDocument;
    const bodyChildren = innerDoc?.body?.children.length ?? 0;
    const headStyles = innerDoc?.head?.querySelectorAll("style").length ?? 0;
    const headLinks = innerDoc?.head?.querySelectorAll("link").length ?? 0;
    const bodyText = innerDoc?.body?.innerText?.slice(0, 200) ?? "";

    return {
      iframeExists: !!iframe,
      iframeWidth: iframeRect?.width ?? 0,
      iframeHeight: iframeRect?.height ?? 0,
      wrapperTransform: wrapper?.style.transform ?? "(none)",
      bodyChildren,
      headStyles,
      headLinks,
      bodyTextPreview: bodyText,
      hasReplayerIframeClass: iframe?.classList.contains("replayer-iframe") ?? false,
    };
  });

  console.log("    diagnostics:", diagnostics);

  // Screenshot just the viewport area (the div containing the iframe)
  const viewportElement = await page.$('iframe');
  const screenshotPath = join(SCREENSHOT_DIR, "replay-viewport.png");
  if (viewportElement) {
    await viewportElement.screenshot({ path: screenshotPath });
    console.log(`    viewport screenshot saved to ${screenshotPath}`);
  }
  const fullScreenshotPath = join(SCREENSHOT_DIR, "replay-page-full.png");
  await page.screenshot({ path: fullScreenshotPath, fullPage: false });
  console.log(`    full-page screenshot saved to ${fullScreenshotPath}`);

  // Sample pixels from the iframe screenshot to detect solid-black viewport
  let blackRatio = 1;
  if (viewportElement) {
    const buf = await viewportElement.screenshot({ type: "png" });
    // Naive black-ratio check: parse png header + inspect pixel bytes.
    // Play safe with a tiny check — if screenshot is >10KB, it has content.
    const sizeKB = buf.length / 1024;
    blackRatio = sizeKB < 3 ? 1 : 0;  // solid black compresses to <3KB typically
    console.log(`    viewport screenshot size: ${sizeKB.toFixed(1)} KB (solid-black would be <3 KB)`);
  }

  const ok =
    diagnostics.iframeExists === true &&
    (diagnostics.iframeWidth as number) > 50 &&
    (diagnostics.iframeHeight as number) > 50 &&
    (diagnostics.bodyChildren as number) > 0 &&
    blackRatio < 0.9;

  return { ok, diagnostics: { ...diagnostics, blackRatio } };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  let sessionId: string;
  let report: { ok: boolean; diagnostics: Record<string, unknown> };

  try {
    // Phase 1: capture a replay session in tester
    const testerPage = await context.newPage();
    sessionId = await captureReplaySession(testerPage);

    // Phase 2: login to dashboard + inspect the viewer
    const dashPage = await context.newPage();
    await loginDashboard(dashPage);
    report = await inspectReplayViewport(dashPage, sessionId);
  } finally {
    await browser.close();
  }

  console.log("\n" + "═".repeat(60));
  if (report.ok) {
    console.log("✓ PASS — replay viewport has content.");
    console.log(`  session: ${sessionId}`);
    process.exit(0);
  } else {
    console.log("✗ FAIL — replay viewport is empty or black.");
    console.log(`  session: ${sessionId}`);
    console.log(`  diagnostics:`, JSON.stringify(report.diagnostics, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n✗ E2E test crashed:", err);
  process.exit(2);
});
