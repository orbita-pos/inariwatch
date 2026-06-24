/**
 * Lazy-redact tests — verifies the split between `redact/config.js`
 * (statically imported by `client.ts`) and `redact/index.js` (dynamic-
 * imported only when redact is enabled). See
 * `docs/decisions/0001-lazy-redact.md` for the design.
 *
 * We can't directly observe whether a dynamic import fired from inside
 * a Node `test` process, so we verify the invariant TWO ways:
 *
 *   1. **Module shape** — `redact/config.js` exports `resolveRedactConfig`
 *      with no transitive deps on patterns/keys/hash. `redact/index.js`
 *      re-exports it so the public API is backward-compatible.
 *
 *   2. **Bundle shape** — when esbuild bundles a user-style entry that
 *      imports only `init + captureException`, the output must NOT
 *      contain the patterns module's signature strings (DEFAULT_PATTERNS,
 *      SENSITIVE_KEYS). When `redactPayload` IS imported, those strings
 *      DO appear. This is the actual "lazy load works" guarantee — if a
 *      bundler accidentally pulls the redactor when it shouldn't, this
 *      test catches it.
 *
 * Run from `capture/`:
 *   node --test test/lazy-redact.test.mjs
 */

import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CAPTURE_ROOT = resolve(__dirname, "..")
const DIST = join(CAPTURE_ROOT, "dist").replace(/\\/g, "/")

// ─── Module shape ───────────────────────────────────────────────────────────

test("config.js: resolveRedactConfig is a separate, importable function", async () => {
  const config = await import("../dist/redact/config.js")
  assert.equal(typeof config.resolveRedactConfig, "function")
  // Normalizing `true` → `{ enabled: true }`
  assert.deepEqual(config.resolveRedactConfig(true), { enabled: true })
  // Normalizing `false` → `{ enabled: false }`
  assert.deepEqual(config.resolveRedactConfig(false), { enabled: false })
  // Normalizing undefined → `{ enabled: false }`
  assert.deepEqual(config.resolveRedactConfig(undefined), { enabled: false })
  // Partial config → merged with enabled:true
  assert.deepEqual(
    config.resolveRedactConfig({ hashMode: true }),
    { enabled: true, hashMode: true },
  )
})

test("index.js: resolveRedactConfig re-exported (backward compat)", async () => {
  const full = await import("../dist/redact/index.js")
  const config = await import("../dist/redact/config.js")
  // The function exported from index.js must be the same identity as
  // the one in config.js — proves the re-export is correct.
  assert.equal(full.resolveRedactConfig, config.resolveRedactConfig)
})

test("index.js: redactPayload still works (sanity, not regressed by the split)", async () => {
  const { redactPayload } = await import("../dist/redact/index.js")
  const out = redactPayload(
    { user: { email: "alice@example.com" } },
    { enabled: true },
  )
  const serialized = JSON.stringify(out)
  assert.ok(
    !serialized.includes("alice@example.com"),
    "raw email must not survive redaction",
  )
  assert.ok(
    serialized.includes("REDACTED_EMAIL"),
    "redacted payload must mark replaced slots",
  )
})

// ─── Bundle shape — the real "lazy load works" guarantee ─────────────────────

/**
 * Bundle a one-off entry file with esbuild + splitting, scan the
 * produced chunks for marker strings from the patterns/keys modules.
 * Returns { initialChunk, allChunks } strings concatenated.
 */
function bundleAndScan(entrySource) {
  const tmp = mkdtempSync(join(tmpdir(), "iw-lazy-redact-"))
  try {
    const entryPath = join(tmp, "entry.mjs")
    writeFileSync(entryPath, entrySource, "utf8")
    const outDir = join(tmp, "out")
    execSync(
      `npx esbuild --bundle --splitting --platform=node --format=esm --target=node18 --packages=external --outdir="${outDir}" "${entryPath}"`,
      { cwd: CAPTURE_ROOT, stdio: "pipe" },
    )
    // Read every emitted .js chunk
    const { readdirSync } = require("node:fs")
    return null // placeholder; replaced below
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Inline implementation (node:test ESM scope vs require shim above)
import { readdirSync } from "node:fs"

function bundleAndCollect(entrySource) {
  const tmp = mkdtempSync(join(tmpdir(), "iw-lazy-redact-"))
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
    return { initial, all, fileCount: files.length }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const REDACT_MARKERS = [
  "DEFAULT_PATTERNS",
  "SENSITIVE_KEYS",
  // Compiled output mangles names; the pattern string content is more
  // stable. These literals appear in patterns.js' regex source.
  "REDACTED_EMAIL",
  "REDACTED_PHONE",
]

test("bundle without redact: initial chunk excludes redactor markers", () => {
  const { initial, all, fileCount } = bundleAndCollect(`
    import { init, captureException, flush } from "${DIST}/index.js"
    init({ dsn: "https://test@example.com/1" })
    captureException(new Error("test"))
    await flush()
  `)
  // At least the entry chunk should exist
  assert.ok(fileCount >= 1, "esbuild should emit at least one chunk")
  // The INITIAL chunk (the entry) must not contain any redactor markers
  for (const m of REDACT_MARKERS) {
    assert.ok(
      !initial.includes(m),
      `initial chunk must NOT contain "${m}" when redact is not imported (found in entry chunk)`,
    )
  }
  // Also check across ALL chunks — without redact, no chunk should
  // contain the markers (because no code path can reach the import).
  for (const m of REDACT_MARKERS) {
    assert.ok(
      !all.includes(m),
      `no chunk should contain "${m}" when nothing imports redactPayload`,
    )
  }
})

test("bundle WITH redactPayload imported: markers appear in some chunk", () => {
  const { all } = bundleAndCollect(`
    import { init, captureException, flush } from "${DIST}/index.js"
    import { redactPayload, resolveRedactConfig } from "${DIST}/redact/index.js"
    init({ dsn: "https://test@example.com/1" })
    const cfg = resolveRedactConfig(true)
    captureException(new Error("test"))
    const out = redactPayload({ email: "a@b.com" }, cfg)
    console.log(out)
    await flush()
  `)
  // At least one of the markers must show up somewhere when
  // redactPayload is imported — proves the markers detection works.
  const hits = REDACT_MARKERS.filter((m) => all.includes(m))
  assert.ok(
    hits.length >= 1,
    `at least one redact marker must appear when redactPayload is imported; found: ${hits.join(", ")}`,
  )
})

test("bundle with init({redact:true}) only (no explicit import): NO markers in any chunk — runtime resolve", () => {
  // Canonical user pattern: `init({ redact: true })` but they never
  // `import { redactPayload }`. Inside `client.ts` the dynamic import
  // uses a string-variable indirection (`const m = "./redact/index.js";
  // import(m)`) — this defeats the bundler's static analysis on
  // purpose. esbuild/Turbopack/Webpack/Vite can't see the import
  // target, so they don't emit a chunk for the redactor at all. The
  // module resolves at RUNTIME against Node's filesystem (works for
  // the Node SDK; Edge/browser entries have separate stub builds via
  // the package.json `edge-light`/`workerd` conditionals).
  //
  // This is intentionally a STRONGER guarantee than "lazy chunk
  // exists": users who never enable redact get a bundle where the
  // patterns module's CODE never lands. Only a literal string with
  // the module path appears, weighing < 30 bytes.
  const { initial, all } = bundleAndCollect(`
    import { init, captureException, flush } from "${DIST}/index.js"
    init({ dsn: "https://test@example.com/1", redact: true })
    captureException(new Error("test"))
    await flush()
  `)
  // The path literal `./redact/index.js` MUST appear (it's the runtime
  // resolve target) — proves we didn't accidentally optimize the
  // dynamic-import away.
  assert.ok(
    initial.includes("./redact/index.js"),
    `initial chunk must reference "./redact/index.js" as the runtime resolve target`,
  )
  // No pattern markers anywhere in the bundle — that's the win.
  for (const m of REDACT_MARKERS) {
    assert.ok(
      !all.includes(m),
      `no chunk should contain "${m}" — the redact module is runtime-resolved, not bundled (string-indirection trick in client.ts)`,
    )
  }
})
