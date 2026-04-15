/**
 * One-off end-to-end: record a replay against the tester app, flush it,
 * then check whether it appears in the dashboard (list + manifest).
 *
 * Doesn't assert anything — just prints what it finds so we can see
 * where the flow is breaking.
 */
import { chromium } from "playwright";

const TESTER = process.env.TESTER_URL ?? "http://localhost:3001";
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    // 1. Record a session against the tester
    const tester = await ctx.newPage();
    const ingestCalls: { url: string; body: string; status: number }[] = [];
    tester.on("request", (req) => {
      if (req.url().includes("/api/replay/ingest")) {
        ingestCalls.push({ url: req.url(), body: req.postData() ?? "", status: 0 });
      }
    });
    tester.on("response", async (resp) => {
      if (resp.url().includes("/api/replay/ingest")) {
        const match = ingestCalls.find((c) => c.status === 0);
        if (match) match.status = resp.status();
      }
    });

    console.log("→ opening tester …");
    await tester.goto(TESTER, { waitUntil: "networkidle" });
    await tester.waitForTimeout(1500);
    const sid = await tester.evaluate(() =>
      (window as unknown as { __INARIWATCH_SESSION__?: string }).__INARIWATCH_SESSION__ ?? null
    );
    console.log(`   sessionId = ${sid}`);

    const vitalsPatched = await tester.evaluate(() =>
      (window as unknown as { __inariwatchVitalsPatched?: boolean }).__inariwatchVitalsPatched
    );
    console.log(`   vitals patched = ${vitalsPatched}`);

    // 2. Click around to generate events
    console.log("→ clicking around …");
    for (let i = 0; i < 5; i++) {
      await tester.mouse.click(200 + i * 40, 300);
      await tester.waitForTimeout(150);
    }
    await tester.waitForTimeout(1000);

    // 3. Force visibility-hidden so vitals flush
    console.log("→ forcing visibility hidden …");
    await tester.evaluate(`(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    })()`);
    await tester.waitForTimeout(500);

    // 4. Close the tab (triggers pagehide + beacon flush)
    console.log("→ closing tester tab …");
    await tester.close();
    // Give sendBeacon time to hit the network
    await new Promise((r) => setTimeout(r, 3000));

    console.log(`\n→ ingest calls fired: ${ingestCalls.length}`);
    for (const c of ingestCalls) {
      const body = c.body.length > 500 ? c.body.slice(0, 500) + "…" : c.body;
      const isFinalMatch = body.match(/"isFinal":(true|false)/);
      console.log(`   ${c.status} isFinal=${isFinalMatch?.[1] ?? "?"} bytes=${c.body.length}`);
    }

    if (!sid) {
      console.log("\n✗ No sessionId captured — SDK may not have initialized.");
      process.exit(1);
    }

    // 5. Dashboard: log in + fetch manifest
    console.log("\n→ logging into dashboard …");
    const dash = await ctx.newPage();
    await dash.goto(`${DASH}/login`, { waitUntil: "networkidle" });
    await dash.fill('input[type="email"]', "demo@inariwatch.com");
    await dash.fill('input[type="password"]', "Demo1234!");
    await Promise.all([
      dash.waitForURL(/\/(dashboard|alerts|replays|projects)/, { timeout: 15000 }),
      dash.click('button[type="submit"]'),
    ]);

    console.log("→ fetching manifest …");
    const manifest = await dash.evaluate(async (id) => {
      const r = await fetch(`/api/replay/${id}/manifest`);
      return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
    }, sid);

    console.log(`   manifest status = ${manifest.status}`);
    if (manifest.status === 200) {
      const m = manifest.body as {
        sessionId: string;
        durationMs: number | null;
        blockCount: number;
        totalBytes: number;
        errorFingerprints: string[];
        webVitals: Record<string, { value: number; rating: string }>;
        endUser: unknown;
      };
      console.log(`   durationMs     = ${m.durationMs}`);
      console.log(`   blockCount     = ${m.blockCount}`);
      console.log(`   totalBytes     = ${m.totalBytes}`);
      console.log(`   errorFingerprints = ${JSON.stringify(m.errorFingerprints)}`);
      console.log(`   webVitals keys = ${Object.keys(m.webVitals ?? {}).join(", ") || "(empty)"}`);
      if (m.webVitals && Object.keys(m.webVitals).length > 0) {
        for (const [k, v] of Object.entries(m.webVitals)) {
          console.log(`     ${k} = ${v.value} (${v.rating})`);
        }
      }
    } else {
      console.log(`   body = ${String(manifest.body).slice(0, 300)}`);
    }

    // 6. Check /replays list
    console.log("\n→ checking /replays list …");
    await dash.goto(`${DASH}/replays?since=all`, { waitUntil: "networkidle" });
    const firstLink = await dash.$(`a[href*="${sid}"]`);
    console.log(`   session ${firstLink ? "FOUND" : "NOT FOUND"} in list`);

    console.log("\n═".repeat(30));
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
