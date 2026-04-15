/**
 * E2E test specifically for the "content shifts when play starts" bug.
 * Takes screenshots at t=0 (paused) and t=3s (playing) and compares
 * viewport geometry + pixel counts.
 *
 * Usage: cd web && npx tsx scripts/e2e-replay-playback-test.ts <sessionId?>
 */
import { chromium, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";
const EMAIL = process.env.TEST_EMAIL ?? "demo@inariwatch.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "Demo1234!";

const OUT = join(process.cwd(), "screenshots");
mkdirSync(OUT, { recursive: true });

async function inspect(page: Page, label: string) {
  await page.waitForTimeout(800);
  const data = await page.evaluate(() => {
    const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
    const wrapper = document.querySelector(".replayer-wrapper") as HTMLElement | null;
    const rect = iframe?.getBoundingClientRect();
    const chain: Array<{ tag: string; cls: string; rect: { w: number; h: number }; xfm: string }> = [];
    let node: HTMLElement | null = iframe;
    while (node && chain.length < 8) {
      const r = node.getBoundingClientRect();
      chain.push({
        tag: node.tagName.toLowerCase(),
        cls: node.className?.toString().slice(0, 40) ?? "",
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        xfm: getComputedStyle(node).transform.slice(0, 60),
      });
      node = node.parentElement;
    }
    return {
      iframe: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
      wrapperTransform: wrapper?.style.transform ?? "(none)",
      iframeWidthAttr: iframe?.getAttribute("width"),
      iframeStyleWidth: iframe?.style.width,
      iframeStyleHeight: iframe?.style.height,
      iframeNaturalW: undefined,  // iframes don't have naturalWidth
      chain,
    };
  });
  console.log(`\n[${label}]`);
  console.log("  iframe rect:", data.iframe);
  console.log("  wrapperTransform:", data.wrapperTransform);
  console.log("  iframe width attr:", data.iframeWidthAttr, "| style.width:", data.iframeStyleWidth);
  console.log("  parent chain (iframe → root):");
  for (const c of data.chain) {
    console.log(`    <${c.tag}> cls="${c.cls}" w=${c.rect.w} h=${c.rect.h} xfm=${c.xfm || "none"}`);
  }
  await page.screenshot({ path: join(OUT, `playback-${label}.png`), fullPage: false });
  return data;
}

async function main() {
  const sessionIdArg = process.argv[2];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  try {
    const page = await context.newPage();

    console.log("Login …");
    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForURL(/\/(dashboard|onboarding|alerts|replays|projects)/, { timeout: 15000 }),
      page.click('button[type="submit"]'),
    ]);

    // Pick the most recent replay session if not given
    let sessionId = sessionIdArg;
    if (!sessionId) {
      console.log("Finding newest replay session …");
      await page.goto(`${DASHBOARD_URL}/replays`, { waitUntil: "networkidle" });
      const firstLink = await page.$('a[href*="/replays/s_"]');
      if (!firstLink) throw new Error("No replay sessions on dashboard");
      const href = await firstLink.getAttribute("href");
      sessionId = href?.split("/").pop() ?? "";
    }

    console.log(`Opening /replays/${sessionId} …`);
    await page.goto(`${DASHBOARD_URL}/replays/${sessionId}`, { waitUntil: "networkidle" });

    await page.waitForSelector("iframe", { timeout: 15000 });
    await page.waitForTimeout(1500);  // let fullsnapshot-rebuilded fire

    const before = await inspect(page, "t0-paused");

    console.log("\nClicking play …");
    // The play/pause button is a ⏸/▶ — find it by role
    const playBtn = await page.$('button[aria-label="Play"]');
    if (playBtn) {
      await playBtn.click();
    } else {
      // Fall back to pressing Space
      await page.keyboard.press("Space");
    }

    await page.waitForTimeout(3000);
    const after = await inspect(page, "t3-playing");

    // Compare geometry
    console.log("\n═".repeat(60));
    console.log("Geometry comparison:");
    console.log(`  iframe x:     before=${before.iframe?.x}  after=${after.iframe?.x}  Δ=${(after.iframe?.x ?? 0) - (before.iframe?.x ?? 0)}`);
    console.log(`  iframe w:     before=${before.iframe?.w}  after=${after.iframe?.w}  Δ=${(after.iframe?.w ?? 0) - (before.iframe?.w ?? 0)}`);
    console.log(`  wrapper xfm:  before="${before.wrapperTransform}"  after="${after.wrapperTransform}"`);

    const shiftX = Math.abs((after.iframe?.x ?? 0) - (before.iframe?.x ?? 0));
    const shiftW = Math.abs((after.iframe?.w ?? 0) - (before.iframe?.w ?? 0));
    if (shiftX > 5 || shiftW > 5) {
      console.log("\n✗ FAIL — viewport shifts more than 5px between paused and playing.");
      console.log("  (bug reproduction confirmed)");
      process.exit(1);
    } else {
      console.log("\n✓ PASS — viewport stays stable across play transition.");
      process.exit(0);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(2); });
