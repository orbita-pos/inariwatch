import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Synthetic CSP audit — replaces the 48h Report-Only observation window.
 *
 * Launches headless Chromium, visits every critical surface, and captures
 * every `securitypolicyviolation` event the browser fires. If zero
 * violations land across an anonymous sweep + a signed-in sweep, the CSP
 * is safe to flip to enforcing now rather than waiting two days of
 * low-traffic production logging.
 *
 * Usage (from web/):
 *   npx tsx scripts/csp-audit.ts                   # anonymous sweep only
 *   DEMO_EMAIL=demo@inariwatch.com \
 *   DEMO_PASSWORD=Demo1234! \
 *     npx tsx scripts/csp-audit.ts                 # anon + signed-in sweep
 *
 *   BASE=https://app.inariwatch.com \
 *   ROOT=https://inariwatch.com \
 *     npx tsx scripts/csp-audit.ts                 # point at different env
 *
 * Exit codes:
 *   0  — zero violations, safe to flip CSP_ENFORCE=true
 *   1  — violations found; review output before enforcing
 *   2  — navigation error (network, timeout) — re-run or investigate
 */

import { chromium, Page, BrowserContext } from "playwright";

const BASE = process.env.BASE ?? "https://app.inariwatch.com";
const ROOT = process.env.ROOT ?? "https://inariwatch.com";

const ANON_PAGES: Array<{ url: string; label: string }> = [
  { url: `${ROOT}/`,                label: "landing" },
  { url: `${ROOT}/pricing`,         label: "pricing" },
  { url: `${ROOT}/replay`,          label: "replay" },
  { url: `${ROOT}/blog`,            label: "blog" },
  { url: `${ROOT}/docs`,            label: "docs" },
  { url: `${BASE}/login`,           label: "login" },
  { url: `${BASE}/register`,        label: "register" },
  { url: `${BASE}/forgot-password`, label: "forgot-password" },
  { url: `${BASE}/reset-password`,  label: "reset-password" },
];

const AUTH_PAGES: Array<{ url: string; label: string }> = [
  { url: `${BASE}/dashboard`,    label: "dashboard" },
  { url: `${BASE}/alerts`,       label: "alerts" },
  { url: `${BASE}/projects`,     label: "projects" },
  { url: `${BASE}/integrations`, label: "integrations" },
  { url: `${BASE}/settings`,     label: "settings" },
  { url: `${BASE}/chat`,         label: "chat" },
  { url: `${BASE}/sessions`,     label: "sessions" },
  { url: `${BASE}/on-call`,      label: "on-call" },
  { url: `${BASE}/analytics`,    label: "analytics" },
];

interface Violation {
  page: string;
  directive: string;
  blockedURI: string;
  sourceFile: string;
  lineNumber: number;
  sample: string;
}

const ALL: Violation[] = [];
const ERRORS: string[] = [];

async function newPageWithListener(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();

  // Attach a listener before any navigation so we catch violations fired
  // during the first paint. Stored on window.__csp so we can read them
  // after the page settles.
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__csp = [];
    window.addEventListener("securitypolicyviolation", (ev) => {
      const e = ev as SecurityPolicyViolationEvent;
      w.__csp.push({
        directive: e.violatedDirective || e.effectiveDirective || "?",
        blockedURI: e.blockedURI || "(inline)",
        sourceFile: e.sourceFile || "",
        lineNumber: e.lineNumber || 0,
        sample: (e.sample || "").slice(0, 200),
      });
    });
  });

  page.on("pageerror", (err) => {
    // Chromium also surfaces some CSP issues as page errors with a
    // known prefix. Collect separately from the structured violations.
    if (err.message.toLowerCase().includes("content security")) {
      ERRORS.push(`pageerror: ${err.message.slice(0, 300)}`);
    }
  });

  return page;
}

async function sweepPage(page: Page, url: string, label: string) {
  try {
    // Use `load` not `networkidle` — pages with SSE / polling (e.g. /alerts)
    // never reach networkidle. load fires on DOMContentLoaded + all initial
    // assets, which is what we need for CSP audit (scripts have attempted
    // to execute by then).
    await page.goto(url, { waitUntil: "load", timeout: 25_000 });
    // Let client components hydrate + third-party scripts attempt to run.
    await page.waitForTimeout(2_500);

    const found = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__csp || [];
    }) as Omit<Violation, "page">[];

    for (const v of found) ALL.push({ page: label, ...v });

    const status = found.length === 0 ? "✓" : "✗";
    console.log(`  ${status} ${label.padEnd(20)}  ${found.length} violation${found.length === 1 ? "" : "s"}`);

    // Reset the collector so the next navigation starts clean.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__csp = [];
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ? ${label.padEnd(20)}  nav error: ${msg.slice(0, 120)}`);
    ERRORS.push(`${label}: ${msg}`);
  }
}

async function signInWithCredentials(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL(new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dashboard`), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function main() {
  console.log(`CSP audit — BASE=${BASE} ROOT=${ROOT}`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    // Mimic a real user so behind-a-CF-edge responses don't path through
    // any bot-mode that would alter HTML + break the test.
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 CSP-Audit/1.0",
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await newPageWithListener(ctx);

    console.log(`\n── Anonymous sweep (${ANON_PAGES.length} pages) ──`);
    for (const p of ANON_PAGES) await sweepPage(page, p.url, p.label);

    const demoEmail = process.env.DEMO_EMAIL;
    const demoPassword = process.env.DEMO_PASSWORD;
    if (demoEmail && demoPassword) {
      console.log(`\n── Signing in as ${demoEmail} ──`);
      try {
        await signInWithCredentials(page, demoEmail, demoPassword);
        console.log(`  ✓ signed in`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ✗ sign-in failed: ${msg.slice(0, 200)}`);
        ERRORS.push(`sign-in: ${msg}`);
      }

      console.log(`\n── Authenticated sweep (${AUTH_PAGES.length} pages) ──`);
      for (const p of AUTH_PAGES) await sweepPage(page, p.url, p.label);
    } else {
      console.log(`\n── Signed-in sweep skipped (set DEMO_EMAIL + DEMO_PASSWORD to include) ──`);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  const total = ALL.length;
  const byPage = new Map<string, number>();
  for (const v of ALL) byPage.set(v.page, (byPage.get(v.page) ?? 0) + 1);

  console.log(`\n═══ Summary ═══`);
  console.log(`Total violations:     ${total}`);
  console.log(`Pages with violations: ${byPage.size}`);

  if (total > 0) {
    console.log(`\nDetails:`);
    for (const v of ALL) {
      console.log(`  [${v.page}] ${v.directive}`);
      console.log(`    blocked=${v.blockedURI}`);
      if (v.sourceFile) console.log(`    source=${v.sourceFile}:${v.lineNumber}`);
      if (v.sample) console.log(`    sample=${v.sample}`);
    }
  }

  if (ERRORS.length > 0) {
    console.log(`\nNav / sign-in errors (${ERRORS.length}):`);
    for (const e of ERRORS) console.log(`  - ${e.slice(0, 300)}`);
  }

  if (total === 0 && ERRORS.length === 0) {
    console.log(`\n✓ Zero violations, zero errors. Safe to flip CSP_ENFORCE=true.`);
    process.exit(0);
  } else if (total === 0 && ERRORS.length > 0) {
    console.log(`\n? Zero CSP violations but ${ERRORS.length} nav errors — investigate before enforcing.`);
    process.exit(2);
  } else {
    console.log(`\n✗ Violations detected — DO NOT flip CSP_ENFORCE yet. Fix the CSP directive or the offending script first.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
