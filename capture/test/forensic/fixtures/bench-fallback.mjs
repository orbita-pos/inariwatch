import { registerForensicHook } from "../../dist/index.js"

const ITERATIONS = Number(process.env.ITERATIONS ?? 300)
const durations = []

const { promise, resolve } = Promise.withResolvers()

await registerForensicHook((capture) => {
  durations.push(capture.captureDurationMs)
})

function throwingFn(i) {
  const a = i
  const b = { name: "bench", idx: i, tags: ["x", "y", i] }
  const c = "hello world " + i
  if (a !== i || !b || !c) return
  throw new Error("bench-" + i)
}

// Chain iterations through uncaughtException — each uncaught throw fires
// Debugger.paused (the hook records duration), then uncaughtException fires
// (we schedule the next). `setPauseOnExceptions: "uncaught"` is what ships
// in prod, so this is the right path to benchmark.
let i = 0

function next() {
  if (i >= ITERATIONS) {
    resolve()
    return
  }
  setImmediate(throwingFn, i)
  i++
}

process.on("uncaughtException", () => {
  // The hook already ran by this point (Debugger.paused → hook → resume →
  // control returns to uncaughtException). Fire the next iteration.
  next()
})

next()

setTimeout(() => {
  process.stderr.write(`timeout: only ${durations.length}/${ITERATIONS} captured\n`)
  resolve()
}, 60_000).unref()

await promise

durations.sort((a, b) => a - b)
const pct = (p) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))]
const avg = durations.reduce((s, d) => s + d, 0) / durations.length

const report = {
  captured: durations.length,
  expected: ITERATIONS,
  p50_ms: Number(pct(50).toFixed(3)),
  p95_ms: Number(pct(95).toFixed(3)),
  p99_ms: Number(pct(99).toFixed(3)),
  max_ms: Number(durations[durations.length - 1].toFixed(3)),
  avg_ms: Number(avg.toFixed(3)),
  node: process.versions.node,
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n")
process.exit(0)
