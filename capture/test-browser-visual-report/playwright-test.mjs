#!/usr/bin/env node
/**
 * End-to-end Playwright drive of the visual-report SDK widget.
 *
 * Prerequisites BEFORE running:
 *   1. web dev server running on http://localhost:3000
 *   2. migration 0096 applied (web/scripts/apply-migration-0096.mjs)
 *   3. (optional) PLATFORM_TOGETHER_KEY in web/.env.local — when present
 *      the pipeline runs end-to-end; without it the upload still
 *      succeeds and the pipeline marks status='failed' with a clear
 *      error message.
 *
 * What this script does:
 *   1. Seeds a throw-away project + iwk_pub_v1_ token via
 *      web/scripts/seed-visual-report-test.mjs.
 *   2. Boots Vite on :5300 to serve `index.html` + `main.ts` (the SDK
 *      page that mounts the widget).
 *   3. Launches Chromium with --disable-web-security so the cross-
 *      origin POST from :5300 → :3000 isn't preflight-blocked. Real
 *      customer apps run on a single origin so the SDK doesn't need
 *      CORS for them; this flag is a test-only workaround.
 *   4. Injects a fake `navigator.mediaDevices.getDisplayMedia` via
 *      addInitScript so the widget's "📸 Attach screenshot" click
 *      completes without a real OS-level capture dialog. The fake
 *      stream comes from a canvas drawing a test pattern, so the
 *      resulting screenshot is real, valid, and reproducible.
 *   5. Drives the UI: open modal → type description → attach
 *      screenshot → submit.
 *   6. Reads `window.__IW_TEST_RESULT__` to capture the SDK's
 *      onUploaded callback payload (reportId + alertId).
 *   7. Polls the DB for the diagnosis completion (or failure) for up
 *      to 90s.
 *   8. Prints a summary of every step.
 *
 * Run from `capture/test-browser-visual-report/`:
 *   node playwright-test.mjs
 */

import { spawn, execFileSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// pg + dotenv live in web/node_modules — capture/ doesn't depend on them.
// createRequire lets us pull CommonJS packages from anywhere on disk.
const __filename0 = fileURLToPath(import.meta.url);
const __dirname0  = dirname(__filename0);
const webRequire  = createRequire(resolve(__dirname0, "..", "..", "web") + "/");
const { Client }  = webRequire("pg");
const { config: dotenvConfig } = webRequire("dotenv");

const __filename = __filename0;
const __dirname  = __dirname0;

dotenvConfig({ path: resolve(__dirname, "..", "..", "web", ".env.local") });

const WEB_URL    = "http://localhost:3000";
const VITE_URL   = "http://127.0.0.1:5300";
const SEED_PATH  = resolve(__dirname, "..", "..", "web", "scripts", "seed-visual-report-test.mjs");

// ── Output helpers ──────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", RESET = "\x1b[0m";
const ok = (m) => console.log(`${G}✓${RESET} ${m}`);
const fail = (m) => console.log(`${R}✗${RESET} ${m}`);
const warn = (m) => console.log(`${Y}⚠${RESET} ${m}`);
const dim = (m) => console.log(`${D}${m}${RESET}`);

// ── Step 1: seed test project + token ──────────────────────────────────────
dim("[1/8] Seeding test project + token via DB…");
let seed;
try {
  const out = execFileSync("node", [SEED_PATH], { encoding: "utf-8" }).trim();
  seed = JSON.parse(out);
  ok(`seeded project ${seed.projectId.slice(0, 8)}… with token ${seed.token.slice(0, 18)}…`);
} catch (e) {
  fail(`seed failed: ${e.message}`);
  process.exit(1);
}

// ── Step 2: ensure web dev server is up ────────────────────────────────────
dim("[2/8] Checking web dev server at " + WEB_URL + "…");
try {
  const r = await fetch(WEB_URL, { method: "HEAD" });
  if (r.status >= 400 && r.status < 500) {
    ok("web is up (returned " + r.status + " — expected for / without auth)");
  } else if (r.ok) {
    ok("web is up");
  } else {
    warn(`web returned ${r.status} — proceeding anyway`);
  }
} catch (e) {
  fail(`web is not reachable at ${WEB_URL} — start it with: cd web && npm run dev`);
  process.exit(1);
}

// ── Step 3: boot Vite ──────────────────────────────────────────────────────
dim("[3/8] Booting Vite on :5300…");
// `shell: true` is required on Windows so the .cmd shim resolves; on
// Unix it's harmless. Without it node spawn throws EINVAL for `npx`.
const viteProc = spawn(
  "npx vite --port 5300",
  { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"], shell: true },
);
const viteReady = new Promise((resolve, reject) => {
  let timeout = setTimeout(() => reject(new Error("Vite didn't become ready in 30s")), 30_000);
  const onChunk = (buf) => {
    const s = String(buf);
    // Strip ANSI colours before matching — Vite's ready line is heavily
    // styled and the codes can land between "Local" and the URL.
    const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
    if (/Local:\s*http/i.test(clean) || /Local:.*5300/i.test(clean)) {
      clearTimeout(timeout);
      resolve();
    }
  };
  viteProc.stdout.on("data", onChunk);
  viteProc.stderr.on("data", onChunk);
});
try {
  await viteReady;
  ok("Vite ready at " + VITE_URL);
} catch (e) {
  fail(e.message);
  viteProc.kill();
  process.exit(1);
}

let exitCode = 0;
try {
  // ── Step 4: launch Chromium ──────────────────────────────────────────────
  dim("[4/8] Launching Chromium…");
  const { chromium } = await import("../../web/node_modules/playwright/index.mjs");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  ok("Chromium up");

  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width: 1280, height: 800 },
  });

  // ── Step 5: inject getDisplayMedia mock + test config ────────────────────
  await context.addInitScript(({ token, projectId, host }) => {
    // Inject test config so main.ts can read it.
    (window).__IW_TEST_CONFIG__ = { token, projectId, host };

    // Mock getDisplayMedia. Returns a real MediaStream from a canvas so
    // the widget's ImageCapture / video-element fallback both work.
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        value: async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 800;
          canvas.height = 600;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#0a0a0c";
          ctx.fillRect(0, 0, 800, 600);
          ctx.fillStyle = "#D8A66E";
          ctx.font = "bold 48px sans-serif";
          ctx.fillText("PLAYWRIGHT MOCK", 180, 250);
          ctx.fillStyle = "#9CC3E8";
          ctx.font = "18px sans-serif";
          ctx.fillText("This is a test screenshot from the e2e harness", 130, 310);
          ctx.fillStyle = "#888690";
          ctx.font = "14px sans-serif";
          ctx.fillText("If you see this, the visual-report SDK widget grabbed it.", 130, 350);
          return canvas.captureStream(0);
        },
        configurable: true,
        writable:     true,
      });
    }
  }, { token: seed.token, projectId: seed.projectId, host: WEB_URL });

  // ── Step 6: open the page + collect logs ─────────────────────────────────
  const page = await context.newPage();
  const consoleMessages = [];
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    consoleMessages.push({ type: "pageerror", text: err.message });
  });

  dim("[5/8] Loading " + VITE_URL + "…");
  await page.goto(VITE_URL);
  // Widget mounts after DOMContentLoaded.
  await page.waitForSelector('[data-inariwatch-feedback="button"]', { timeout: 5_000 });
  ok("widget button mounted");

  // ── Step 7: drive the UI ────────────────────────────────────────────────
  dim("[6/8] Driving the UI…");

  await page.click('[data-inariwatch-feedback="button"]');
  await page.waitForSelector('[data-inariwatch-feedback="modal"][aria-hidden="false"]', { timeout: 2_000 });
  ok("modal open");

  // Append a nonce so re-running the test doesn't collide with the prior
  // run's title-based dedup in createAlertIfNew(). For real users an
  // identical description within 24h is exactly the right thing to dedup;
  // the e2e harness just needs each invocation to land a fresh alert.
  const nonce = new Date().toISOString().replace(/[^0-9]/g, "").slice(8, 14);
  await page.fill(
    '[data-inariwatch-feedback="form"] textarea',
    `The submit button is floating outside its container box — looks wrong on the test fixture. [run ${nonce}]`,
  );
  ok("description filled");

  await page.click('[data-inariwatch-feedback="screenshot-btn"]');
  // Wait for screenshot preview to appear (img inside the preview div).
  await page.waitForSelector('[data-inariwatch-feedback="screenshot-preview"] img', { timeout: 5_000 });
  ok("screenshot attached (canvas mock)");

  await page.click('[data-inariwatch-feedback="submit"]');
  ok("submit clicked — waiting for upload…");

  // ── Step 8: assert upload result ─────────────────────────────────────────
  const uploadResult = await page.waitForFunction(
    () => window.__IW_TEST_RESULT__?.uploadResult,
    { timeout: 30_000 },
  ).then((h) => h.jsonValue());

  if (!uploadResult || uploadResult.ok !== true || !uploadResult.reportId) {
    fail("upload failed: " + JSON.stringify(uploadResult));
    console.log("");
    console.log(D + "Console log dump:" + RESET);
    for (const m of consoleMessages.slice(-20)) {
      console.log(`  [${m.type}] ${m.text}`);
    }
    throw new Error("Upload assertion failed");
  }
  ok(`upload OK — reportId=${uploadResult.reportId.slice(0, 8)}… alertId=${uploadResult.alertId.slice(0, 8)}…`);

  await browser.close();

  // ── Step 9: poll DB for diagnosis ────────────────────────────────────────
  dim("[7/8] Polling DB for pipeline completion (up to 150s)…");
  const pgClient = new Client({ connectionString: process.env.DATABASE_URL });
  await pgClient.connect();
  try {
    const start = Date.now();
    let lastStatus = "pending";
    let finalRow = null;
    while (Date.now() - start < 150_000) {
      const r = await pgClient.query(
        `SELECT status, confidence, error, diagnosis, model_diagnose, duration_ms, cost_cents
           FROM visual_reports WHERE id = $1`,
        [uploadResult.reportId],
      );
      const row = r.rows[0];
      if (!row) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      lastStatus = row.status;
      if (lastStatus !== "pending" && lastStatus !== "triaging" && lastStatus !== "diagnosing" && lastStatus !== "critiquing") {
        finalRow = row;
        break;
      }
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.log("");

    if (!finalRow) {
      warn(`pipeline still in-flight after 150s (last status: ${lastStatus})`);
    } else if (finalRow.status === "completed") {
      ok(`pipeline COMPLETED — confidence=${finalRow.confidence}, ${finalRow.duration_ms}ms, ${finalRow.cost_cents}¢`);
      const dx = finalRow.diagnosis;
      if (dx?.root_cause) {
        console.log(`    root_cause.file:     ${dx.root_cause.file || "(not identified)"}`);
        console.log(`    root_cause.line:     ${dx.root_cause.line}`);
        console.log(`    root_cause.function: ${dx.root_cause.function || "(not identified)"}`);
        console.log(`    evidence count:      ${dx.evidence?.length ?? 0}`);
        console.log(`    unknowns count:      ${dx.unknowns?.length ?? 0}`);
        console.log(`    fix hint:            ${(dx.recommended_fix_hint || "").slice(0, 100)}`);
      }
    } else if (finalRow.status === "need_info") {
      ok(`pipeline NEED_INFO — confidence=${finalRow.confidence}, unknowns=${finalRow.diagnosis?.unknowns?.length ?? 0}`);
    } else if (finalRow.status === "failed") {
      warn(`pipeline FAILED — error: ${finalRow.error}`);
      warn("This is expected if PLATFORM_TOGETHER_KEY is not set in web/.env.local.");
    } else {
      warn(`pipeline status: ${finalRow.status} (unexpected — check the row directly)`);
    }
  } finally {
    await pgClient.end();
  }

  // ── Step 10: summary ─────────────────────────────────────────────────────
  dim("[8/8] Done.");
  ok("Visual report e2e test passed.");
} catch (err) {
  fail(`E2E test failed: ${err.message}`);
  exitCode = 1;
} finally {
  viteProc.kill();
}

process.exit(exitCode);
