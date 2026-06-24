/**
 * Lazy-intent tests — verifies the string-variable indirection on
 * `await import("./intent/index.js")` keeps the 30 KB intent module
 * out of bundles when CAPTURE_INTENT_COMPILER isn't activated.
 * See `docs/decisions/0002-lazy-intent.md`.
 *
 * The test bundles a user-style entry with esbuild + splitting (the
 * default behavior of Next.js Turbopack, Vite, and Webpack for ESM
 * dynamic imports). It then scans the produced chunks for marker
 * strings unique to the intent module's source-parsers.
 *
 * Run from `capture/`:
 *   node --test test/lazy-intent.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURE_ROOT = resolve(__dirname, "..")
const DIST = join(CAPTURE_ROOT, "dist").replace(/\\/g, "/")

// Marker strings that appear in compiled `intent/` source. Picked to
// be distinct from anything outside the intent module — `zodSource` is
// the exported variable name in `intent/sources/zod.ts`. We
// deliberately AVOID `extractIntentForFrame` here because it appears
// as the destructuring identifier of the dynamic import call site in
// `v2-emit.ts` (`const { extractIntentForFrame } = await import(...)`),
// which lives in v2-emit regardless of whether intent's body ships.
// If a future refactor renames the parser source exports, this test
// (correctly) starts failing and flags the marker list as stale.
const INTENT_MARKERS = [
  "typescriptSource",
  "zodSource",
  "openapiSource",
  "drizzleSource",
  "prismaSource",
  "graphqlSource",
]

function bundleAndCollect(entrySource) {
  const tmp = mkdtempSync(join(tmpdir(), "iw-lazy-intent-"))
  const entryPath = join(tmp, "entry.mjs").replace(/\\/g, "/")
  writeFileSync(entryPath, entrySource, "utf8")
  const outDir = join(tmp, "out").replace(/\\/g, "/")
  try {
    execSync(
      `npx esbuild --bundle --splitting --platform=node --format=esm --target=node18 --packages=external --outdir="${outDir}" "${entryPath}"`,
      { cwd: CAPTURE_ROOT, stdio: "pipe" },
    )
    const files = readdirSync(outDir).filter((f) => f.endsWith(".js"))
    const initialName = files.find((f) => f.startsWith("entry")) ?? files[0]
    const initial = readFileSync(join(outDir, initialName), "utf8")
    const all = files.map((f) => readFileSync(join(outDir, f), "utf8")).join("\n")
    return { initial, all, fileCount: files.length, files }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test("bundle without intent: no chunk contains intent parser markers", () => {
  // Canonical user pattern. Intent never imported, never activated.
  // The full intent module must NOT ship in any chunk.
  const { all, files } = bundleAndCollect(`
    import { init, captureException, flush } from "${DIST}/index.js"
    init({ dsn: "https://test@example.com/1" })
    captureException(new Error("test"))
    await flush()
  `)
  for (const m of INTENT_MARKERS) {
    assert.ok(
      !all.includes(m),
      `no chunk should contain intent marker "${m}" — intent must be runtime-resolved, not bundled. Chunks: ${files.join(", ")}`,
    )
  }
})

test("bundle with payload-v2 active (no CAPTURE_INTENT_COMPILER): intent still excluded", () => {
  // Even when v2-emit is reachable (the user imports buildPayloadV2*),
  // the intent module must NOT ship — the env flag gates the runtime
  // path AND the string indirection blocks the bundler from finding it.
  const { all, files } = bundleAndCollect(`
    import { init, flush, prepareV2Payload, buildPayloadV2Unsigned } from "${DIST}/index.js"
    init({ dsn: "https://test@example.com/1" })
    const v = await prepareV2Payload({})
    const u = buildPayloadV2Unsigned({})
    console.log(v, u)
    await flush()
  `)
  for (const m of INTENT_MARKERS) {
    assert.ok(
      !all.includes(m),
      `payload-v2 active but no intent flag: chunk must not contain "${m}". Chunks: ${files.join(", ")}`,
    )
  }
  // The path literal "./intent/index.js" SHOULD appear somewhere as
  // the runtime resolve target — proves we didn't accidentally remove
  // the dynamic import altogether.
  assert.ok(
    all.includes("./intent/index.js"),
    `at least one chunk should reference "./intent/index.js" as runtime target`,
  )
})

test("explicit intent import: parser markers appear (sanity check on the marker list)", () => {
  // If a future refactor renames `zodSource`, etc., this test starts
  // failing and flags the marker list as stale. Also proves the
  // markers ARE present when intent is genuinely included — guards
  // against false-negatives in the tests above.
  const { all } = bundleAndCollect(`
    import { extractIntentForFrame, zodSource, typescriptSource } from "${DIST}/intent/index.js"
    const r = extractIntentForFrame({ file: "x.ts" })
    console.log(r, zodSource, typescriptSource)
  `)
  const hits = INTENT_MARKERS.filter((m) => all.includes(m))
  assert.ok(
    hits.length >= 3,
    `at least 3 intent markers should appear when intent is imported. Found: ${hits.join(", ")}`,
  )
})
