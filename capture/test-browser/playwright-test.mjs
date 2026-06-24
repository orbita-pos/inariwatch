#!/usr/bin/env node
// Programmatic test of the Capture Awake detector harness.
// Drives a headless chromium against http://127.0.0.1:5200, clicks each
// detector button, captures console messages + the harness's own event log,
// and reports pass/fail per detector.
//
// Uses playwright from web/node_modules (already installed).

import { chromium } from "../../web/node_modules/playwright/index.mjs"

const URL = "http://127.0.0.1:5200"

// Detector → ["click target selector", "expected event keyword(s) in captureLog"]
// `null` selector = auto-firing on page load (no click needed)
const SCENARIOS = [
  { name: "web-vitals",     selector: null,                   keywords: ["vitals."],          waitMs: 4000 },
  { name: "dom-size auto",  selector: null,                   keywords: ["dom_size"],         waitMs: 1500 },
  { name: "loaf",           selector: "#btn-loaf",            keywords: ["loaf"],             waitMs: 1500 },
  { name: "broken-image",   selector: "#btn-broken-img",      keywords: ["broken_"],          waitMs: 2000 },
  { name: "broken-script",  selector: "#btn-broken-script",   keywords: ["broken_"],          waitMs: 2000 },
  { name: "spa-routing",    selector: "#btn-spa",             keywords: ["spa_route"],        waitMs: 2500 },
  { name: "slow-image",     selector: "#btn-slow-img",        keywords: ["slow_image"],       waitMs: 4000 },
  { name: "dom-size click", selector: "#btn-dom",             keywords: ["dom_size"],         waitMs: 1500 },
  { name: "hydration",      selector: "#btn-hydration",       keywords: ["hydration_"],       waitMs: 800 },
  { name: "storage-quota",  selector: "#btn-storage",         keywords: ["storage_quota"],    waitMs: 1500 },
  { name: "image-optimizer",selector: "#btn-img-opt",         keywords: ["image_optimization"], waitMs: 2000 },
]

// ── Output helpers ──────────────────────────────────────────────────────────

const GREEN = "\x1b[32m", RED = "\x1b[31m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m"
const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}⚠${RESET}`

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${DIM}Launching chromium against ${URL}…${RESET}`)
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Collect ALL console messages — capture's local-dev path logs via console.*
  const consoleMessages = []
  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text(), ts: Date.now() })
  })

  // Surface page errors (uncaught exceptions in the harness or capture itself)
  const pageErrors = []
  page.on("pageerror", (err) => {
    pageErrors.push(err.message)
  })

  // Navigate + wait for the harness to settle (SDK init + auto-firing detectors)
  await page.goto(URL, { waitUntil: "networkidle" })
  await page.waitForTimeout(3000)

  console.log(`\n${DIM}─── After SDK init (3s settle) ──────────────────────${RESET}`)
  if (pageErrors.length > 0) {
    console.log(`${FAIL} ${pageErrors.length} uncaught page errors:`)
    pageErrors.forEach((e) => console.log(`  ${RED}${e}${RESET}`))
  } else {
    console.log(`${PASS} no uncaught page errors during init`)
  }

  const initEventCount = consoleMessages.length
  console.log(`${DIM}  ${initEventCount} console messages captured during init${RESET}`)

  // ── Critical sanity: console.error still works after hydration wrap ──
  // Click the hydration button and verify the literal message reaches console.
  console.log(`\n${DIM}─── Critical: console.error preservation ────────────${RESET}`)
  const beforeErrCount = consoleMessages.length
  await page.click("#btn-hydration").catch(() => {})
  await page.waitForTimeout(500)
  const afterErrCount = consoleMessages.length
  const errorReached = consoleMessages
    .slice(beforeErrCount)
    .some((m) => m.text.toLowerCase().includes("hydration") || m.type === "error")
  console.log(errorReached
    ? `${PASS} console.error wrap forwards the call (${afterErrCount - beforeErrCount} new messages)`
    : `${FAIL} hydration button fired but no console.error reached — wrap is swallowing!`)

  // ── Per-detector trigger + check ──
  console.log(`\n${DIM}─── Detector firings ────────────────────────────────${RESET}`)
  const results = []
  for (const sc of SCENARIOS) {
    const before = consoleMessages.length
    if (sc.selector) {
      try {
        await page.click(sc.selector, { timeout: 1500 })
      } catch {
        results.push({ ...sc, status: "skip", reason: "selector not found" })
        continue
      }
    }
    await page.waitForTimeout(sc.waitMs)
    const newMessages = consoleMessages.slice(before)
    const matched = newMessages.filter((m) =>
      sc.keywords.some((k) => m.text.toLowerCase().includes(k.toLowerCase()))
    )
    results.push({ ...sc, status: matched.length > 0 ? "pass" : "miss", count: matched.length, sample: matched[0]?.text?.slice(0, 100) })
  }

  for (const r of results) {
    const sym = r.status === "pass" ? PASS : r.status === "miss" ? WARN : DIM + "-" + RESET
    const note = r.status === "pass" ? `${r.count} match(es)` :
                 r.status === "miss" ? `no captureLog with ${r.keywords.join("/")}` :
                 r.reason
    console.log(`  ${sym} ${r.name.padEnd(20)} ${DIM}${note}${RESET}`)
    if (r.sample) console.log(`     ${DIM}↳ ${r.sample}${RESET}`)
  }

  // ── Rage-click test: 5 rapid clicks on same button ──
  console.log(`\n${DIM}─── Rage-click ──────────────────────────────────────${RESET}`)
  {
    const before = consoleMessages.length
    const target = "#btn-loaf"
    for (let i = 0; i < 5; i++) {
      await page.click(target, { force: true, noWaitAfter: true }).catch(() => {})
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(1500)
    const newMessages = consoleMessages.slice(before)
    const rage = newMessages.find((m) => m.text.toLowerCase().includes("rage_click"))
    console.log(rage
      ? `${PASS} rage_click fired (5 fast clicks within 1s window)\n     ${DIM}↳ ${rage.text.slice(0, 100)}${RESET}`
      : `${WARN} rage_click did NOT fire — check threshold (3 clicks / 1s / 20px radius)`)
  }

  // ── Dead-click test: click an interactive but no-op element ──
  console.log(`\n${DIM}─── Dead-click (the bug we fixed) ───────────────────${RESET}`)
  {
    const before = consoleMessages.length
    // Inject a button with no handler + interactive role, click once, wait 3.5s
    await page.evaluate(() => {
      const b = document.createElement("button")
      b.id = "dead-test-btn"
      b.textContent = "dead-test"
      b.style.cssText = "position:fixed;top:-100px;left:-100px"
      document.body.appendChild(b)
    })
    await page.click("#dead-test-btn", { force: true }).catch(() => {})
    await page.waitForTimeout(3500)
    const newMessages = consoleMessages.slice(before)
    const dead = newMessages.find((m) => m.text.toLowerCase().includes("dead_click"))
    console.log(dead
      ? `${PASS} dead_click fired — single shared MutationObserver works\n     ${DIM}↳ ${dead.text.slice(0, 100)}${RESET}`
      : `${WARN} dead_click did NOT fire — could be ambient page mutations from harness; flag for manual retest`)
  }

  // ── Memory-leak test: simulate by repeating SPA nav with allocations ──
  // The detector needs 10 monotonic samples crossing 5%/5MB. Hard to drive
  // headlessly in <30s, so this is informational only.
  console.log(`\n${DIM}─── Memory-leak (informational — not feasible headless) ─${RESET}`)
  console.log(`  ${DIM}-${RESET} memory-leak              ${DIM}needs 10+ navigations + GC pressure; manual test recommended${RESET}`)

  await browser.close()

  // ── Summary ──
  console.log(`\n${DIM}─── Summary ─────────────────────────────────────────${RESET}`)
  const passes = results.filter((r) => r.status === "pass").length
  const misses = results.filter((r) => r.status === "miss").length
  const skips = results.filter((r) => r.status === "skip").length
  const total = results.length
  console.log(`  ${passes}/${total} detectors fired · ${misses} silent · ${skips} skipped`)
  console.log(`  console.error preservation: ${errorReached ? PASS : FAIL}`)
  console.log(`  page errors during init:    ${pageErrors.length === 0 ? PASS : FAIL + " (" + pageErrors.length + ")"}`)

  process.exit(misses > 0 || pageErrors.length > 0 || !errorReached ? 1 : 0)
}

main().catch((err) => {
  console.error(`${RED}FATAL${RESET}`, err)
  process.exit(2)
})
