import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  registerForensicHook,
  unregisterForensicHook,
  __mode,
} from "../dist/index.js"

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * End-to-end capture runs in a subprocess. Reason: node:test hooks
 * into process-level `uncaughtException` for its own reporting — if we
 * throw inside the current process, the test runner sees it and fails
 * the test before the CDP pause path completes. A child process runs
 * the fixture in isolation and writes the capture JSON to stdout.
 */
test("captures frame locals of an uncaught throw (subprocess)", { timeout: 15_000 }, () => {
  const fixture = path.join(here, "fixtures", "throw-with-locals.mjs")
  const result = spawnSync(process.execPath, [fixture], { encoding: "utf8" })
  assert.equal(result.status, 0, `fixture exit=${result.status} stderr=${result.stderr}`)
  assert.ok(result.stdout.length > 0, `no stdout; stderr=${result.stderr}`)

  const capture = JSON.parse(result.stdout) as {
    source: string
    frames: Array<{
      functionName: string
      locals: Array<{ name: string; repr: string; kind: string }>
    }>
    pid: number
    captureDurationMs: number
  }

  assert.equal(capture.source, "inspector")
  assert.ok(capture.frames.length > 0, "expected at least one frame")
  assert.ok(typeof capture.captureDurationMs === "number" && capture.captureDurationMs >= 0)

  const throwingFrame = capture.frames.find((f) => f.functionName === "throwingFn")
  assert.ok(
    throwingFrame,
    `expected a throwingFn frame, got ${JSON.stringify(capture.frames.map((f) => f.functionName))}`,
  )
  const names = throwingFrame.locals.map((l) => l.name).sort()
  // CDP reports locals lazily — at minimum `answer` should appear since it's
  // referenced by the boolean guard right before the throw.
  assert.ok(
    names.includes("answer") || names.includes("name") || names.includes("payload"),
    `expected locals answer/name/payload, got [${names.join(", ")}]`,
  )
})

test("double register throws", { timeout: 5_000 }, async (t) => {
  await registerForensicHook(() => {})
  t.after(async () => {
    await unregisterForensicHook()
  })
  await assert.rejects(() => registerForensicHook(() => {}), /already registered/)
})

test("mode flips back to null after uninstall", { timeout: 5_000 }, async () => {
  await registerForensicHook(() => {})
  assert.equal(__mode(), "inspector")
  await unregisterForensicHook()
  assert.equal(__mode(), null)
})
