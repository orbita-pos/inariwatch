#!/usr/bin/env node
/**
 * Curl-equivalent backend smoke test for the visual-report endpoint.
 *
 * Skips the browser entirely — fabricates a realistic capture bundle +
 * 1x1 PNG screenshot and POSTs to /api/capture/user-report/[projectId].
 * Useful for validating the backend path without setting up the demo
 * Next.js app.
 *
 * Run from `capture/demo/visual-report-test/`:
 *   # Set TOKEN + PROJECT_ID inline OR rely on .env.local:
 *   node curl-test.mjs
 *
 * Verifies:
 *   1. POST returns 200 with reportId + alertId
 *   2. (After ~30s if PLATFORM_TOGETHER_KEY is configured on the server)
 *      the desktop API returns a populated diagnosis
 *
 * Note: this script reads .env.local from the SAME directory (the demo
 * app's .env.local — see .env.example for the keys).
 */

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, ".env.local") });

const TOKEN      = process.env.NEXT_PUBLIC_INARIWATCH_TOKEN;
const PROJECT_ID = process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID;
const HOST       = process.env.NEXT_PUBLIC_INARIWATCH_HOST ?? "http://localhost:3000";

if (!TOKEN || !PROJECT_ID || TOKEN.includes("REPLACE_ME")) {
  console.error("❌ Set NEXT_PUBLIC_INARIWATCH_TOKEN and NEXT_PUBLIC_INARIWATCH_PROJECT_ID in .env.local first.");
  process.exit(1);
}

// 1x1 transparent PNG (smallest valid screenshot — server-side it just
// needs to be a data: URI; AI vision call would obviously want a real
// image, but this is enough to exercise the upload path).
const SCREENSHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Fabricate a realistic bundle. Matches CaptureBundle from
// capture/src/visual-report/capture-context.ts.
const bundle = {
  url:        "http://localhost:3001/dashboard?view=settings",
  userAgent:  "Mozilla/5.0 (curl-test) AppleWebKit/537.36",
  viewport:   { width: 1280, height: 800, dpr: 2 },
  buildId:    "demo-build-xyz",
  capturedAt: Date.now(),
  focused: {
    outerHtml: '<button class="submit-btn">Save changes</button>',
    selector:  "form.settings > button.submit-btn",
    styles:    {
      display:  "inline-block",
      position: "absolute",
      top:      "-8px",
      right:    "-32px",
    },
    ax: {
      tag:      "button",
      role:     "button",
      name:     "Save changes",
      disabled: false,
    },
    rect: { x: 412, y: -8, w: 96, h: 28 },
  },
  console: [
    {
      level: "error",
      ts:    Date.now() - 4000,
      args:  ["Warning: useEffect cleanup expected to return a function, got: undefined"],
      site:  "at SettingsForm (Settings.tsx:42:18)",
    },
  ],
  network: [
    {
      url:    "http://localhost:3001/api/settings",
      method: "GET",
      status: 200,
      ts:     Date.now() - 6000,
      durMs:  142,
      size:   1024,
      source: "fetch",
    },
  ],
  webVitals:  { lcp: 1843, cls: 0.12, inp: 240 },
  memory:     { used: 18_000_000, total: 60_000_000, limit: 500_000_000 },
  captureMs:  87,
};

const endpoint = `${HOST.replace(/\/$/, "")}/api/capture/user-report/${PROJECT_ID}`;

console.log(`POST ${endpoint}`);
const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({
    screenshot:  SCREENSHOT,
    bundle,
    description: "The Save button is floating outside its form container — looks broken on the settings page.",
    captureMs:   bundle.captureMs,
    redactionStats: { emails: 0, tokens: 0, cards: 0 },
  }),
});

console.log(`→ ${res.status} ${res.statusText}`);
const body = await res.json();
console.log(JSON.stringify(body, null, 2));

if (!res.ok || !body.reportId) {
  console.error("❌ Upload failed. Check the server logs.");
  process.exit(1);
}

console.log(`\n✓ Report created: ${body.reportId}`);
console.log(`✓ Alert created:  ${body.alertId}`);
console.log(`\nWaiting up to 60s for the diagnosis pipeline to run…`);

// Poll the desktop API endpoint until status leaves the in-flight set
// (or 60s timeout). Note: the desktop endpoint uses the EXTENSION bearer
// token, not the SDK token. For a smoke test we hit the public-API row
// directly via psql below — or just describe what to look for.
const start = Date.now();
let lastStatus = "pending";
while (Date.now() - start < 60_000) {
  await new Promise((r) => setTimeout(r, 4000));
  // The desktop endpoint requires a different bearer (extension token)
  // that the SDK doesn't have. So we poll via the public alert page
  // status instead — it'll show "Diagnosed" / "Need more info" / "Failed"
  // in the future. For now just log.
  process.stdout.write(".");
  lastStatus = "(in-flight — check Inari Live desktop or psql)";
}
console.log(`\n\nFinal status (from this side): ${lastStatus}`);
console.log(`Open Inari Live → Inbox → look for the new alert.`);
console.log(`Or query the DB directly:`);
console.log(`  psql $DATABASE_URL -c "SELECT status, confidence, diagnosis->>'recommended_fix_hint' FROM visual_reports WHERE id = '${body.reportId}'"`);
