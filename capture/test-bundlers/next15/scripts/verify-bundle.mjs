#!/usr/bin/env node
/**
 * After `next build`, walk every JS file under `.next/` and assert
 * the heavy-module markers don't appear. Mirrors the bundle-shape
 * tests in `capture/test/lazy-redact.test.mjs` and `lazy-intent.test.mjs`,
 * but exercises the REAL Next.js / Turbopack bundler instead of
 * standalone esbuild — closer to what a real user produces.
 *
 * Fails (exit 1) if any heavy-module marker appears in the bundle.
 *
 * Run:
 *   npm install
 *   npm run build
 *   npm run verify
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const BUILD = join(ROOT, ".next")

// Markers from the heavy modules. Each one is a tight string that
// SHOULD never appear in a bundle that didn't import the module
// explicitly. If a future Next.js / Turbopack version starts pulling
// these into the SSR chunks, this script catches it.
const HEAVY_MARKERS = {
  // Redact module (~7 KB minified)
  redact: ["DEFAULT_PATTERNS", "SENSITIVE_KEYS", "REDACTED_EMAIL"],
  // Intent module (~30 KB across 6 parsers)
  intent: ["typescriptSource", "zodSource", "openapiSource", "drizzleSource", "prismaSource", "graphqlSource"],
  // Causal graph engine (~12 KB)
  causal: ["installPgHook", "installPrismaHook", "installAllHooks", "extractSubgraph"],
}

function walkJs(dir) {
  const out = []
  function rec(p) {
    let entries
    try { entries = readdirSync(p) } catch { return }
    for (const e of entries) {
      const full = join(p, e)
      const s = statSync(full)
      if (s.isDirectory()) rec(full)
      else if (e.endsWith(".js") || e.endsWith(".mjs")) out.push(full)
    }
  }
  rec(dir)
  return out
}

function main() {
  const files = walkJs(BUILD)
  if (files.length === 0) {
    console.error(`No JS files under ${BUILD} — did you run \`next build\`?`)
    process.exit(2)
  }
  console.log(`Scanning ${files.length} JS files in .next/`)

  // For each marker, find the FIRST file it appears in (and bail).
  // This keeps the output readable on regression.
  const hits = []
  for (const [moduleName, markers] of Object.entries(HEAVY_MARKERS)) {
    for (const marker of markers) {
      for (const f of files) {
        const content = readFileSync(f, "utf8")
        if (content.includes(marker)) {
          hits.push({ module: moduleName, marker, file: f.replace(BUILD, ".next") })
          break
        }
      }
    }
  }

  if (hits.length === 0) {
    console.log(`OK — no heavy-module markers in any Next.js bundle output.`)
    process.exit(0)
  }

  console.error(`\nFAIL — found ${hits.length} heavy-module marker(s) in the bundle:\n`)
  for (const h of hits) {
    console.error(`  ${h.module}: "${h.marker}" in ${h.file}`)
  }
  console.error(`\nThis means a refactor leaked a heavy module into the initial bundle.`)
  console.error(`Check: capture/docs/decisions/0001-lazy-redact.md and 0002-lazy-intent.md`)
  console.error(`for the indirection pattern the SDK relies on.`)
  process.exit(1)
}

main()
