import { registerForensicHook } from "../../dist/index.js"

// Swallow the uncaught so Node doesn't abort before the hook serializes.
// Real users get the throw propagated as usual — we only swallow inside the
// fixture so we can assert on the capture.
process.on("uncaughtException", () => {})

await registerForensicHook((capture) => {
  const replacer = (_key, v) => {
    if (typeof v === "bigint") return v.toString() + "n"
    if (v instanceof Error) return { name: v.name, message: v.message }
    return v
  }
  process.stdout.write(JSON.stringify(capture, replacer))
  // Exit 0 — the test only cares about what the hook observed.
  process.exit(0)
})

function throwingFn() {
  const answer = 42
  const name = "forensic-test"
  const payload = { a: 1, b: [1, 2, 3] }
  // Reference them so V8 doesn't dead-code-eliminate.
  if (answer !== 42 || name.length !== "forensic-test".length || !payload) return
  throw new Error("boom")
}

// Throw uncaught from a top-level scheduler tick so CDP pauses on it.
setImmediate(throwingFn)

// Fallback: if the hook somehow doesn't fire within 3s, fail hard so CI
// surfaces the regression instead of hanging.
setTimeout(() => {
  process.stderr.write("timeout: forensic hook never fired\n")
  process.exit(2)
}, 3000).unref()
