#!/usr/bin/env node
// Test harness for @inariwatch/capture across multiple bundlers.
// Each sub-app imports capture, builds with its bundler, and runs the output.
// The runner greps stdout/stderr for error patterns and reports a matrix.
//
// Usage:  node run-all.mjs
// Exit 0 if all pass, 1 otherwise.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const ERROR_PATTERNS = [
  /Module not found.*crypto/i,
  /UnhandledSchemeError/i,
  /Can't resolve 'node:/i,
  /\[error\]/i,
  /✖|✗/,
]

const apps = [
  {
    name: "node-esm",
    dir: "node-esm",
    install: true,
    steps: [{ label: "runtime", cmd: "node", args: ["--import", "@inariwatch/capture/auto", "app.js"] }],
  },
  {
    name: "esbuild",
    dir: "esbuild-app",
    install: true,
    steps: [
      { label: "build", cmd: "npm", args: ["run", "build"] },
      { label: "runtime", cmd: "node", args: ["dist/out.mjs"] },
    ],
  },
  {
    name: "webpack",
    dir: "webpack-app",
    install: true,
    steps: [
      { label: "build", cmd: "npm", args: ["run", "build"] },
      { label: "runtime", cmd: "node", args: ["dist/out.cjs"] },
    ],
  },
  {
    name: "vite",
    dir: "vite-app",
    install: true,
    steps: [
      { label: "build", cmd: "npm", args: ["run", "build"] },
      { label: "runtime", cmd: "node", args: ["dist/entry.js"] },
    ],
  },
  {
    name: "rollup",
    dir: "rollup-app",
    install: true,
    steps: [
      { label: "build", cmd: "npm", args: ["run", "build"] },
      { label: "runtime", cmd: "node", args: ["dist/out.mjs"] },
    ],
  },
  {
    name: "next-webpack",
    dir: "next-app",
    install: true,
    steps: [{ label: "build", cmd: "npm", args: ["run", "build"] }],
  },
  {
    name: "next-turbopack",
    dir: "next-app",
    install: false,
    steps: [{ label: "build", cmd: "npm", args: ["run", "build:turbo"] }],
  },
  {
    name: "nuxt",
    dir: "nuxt-app",
    install: true,
    steps: [{ label: "build", cmd: "npm", args: ["run", "build"] }],
  },
]

function run(cwd, cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd,
    shell: process.platform === "win32",
    encoding: "utf8",
    env: { ...process.env, INARIWATCH_DSN: "" },
  })
  return {
    code: result.status ?? 1,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  }
}

function checkOutput(output) {
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.test(output)) return pattern.toString()
  }
  return null
}

const results = []
let anyFailed = false

for (const app of apps) {
  const cwd = join(__dirname, app.dir)
  if (!existsSync(cwd)) {
    results.push({ name: app.name, status: "SKIP", detail: "dir missing" })
    continue
  }

  if (app.install && !existsSync(join(cwd, "node_modules"))) {
    console.log(`[${app.name}] installing…`)
    const inst = run(cwd, "npm", ["install", "--silent"])
    if (inst.code !== 0) {
      results.push({ name: app.name, status: "FAIL", detail: `install failed (${inst.code})` })
      anyFailed = true
      continue
    }
  }

  let failedStep = null
  for (const step of app.steps) {
    console.log(`[${app.name}] ${step.label}…`)
    const r = run(cwd, step.cmd, step.args)
    const patternHit = checkOutput(r.output)
    if (r.code !== 0 || patternHit) {
      failedStep = { label: step.label, code: r.code, pattern: patternHit, tail: r.output.split("\n").slice(-10).join("\n") }
      break
    }
  }

  if (failedStep) {
    results.push({ name: app.name, status: "FAIL", detail: `${failedStep.label}: ${failedStep.pattern ?? `exit ${failedStep.code}`}`, tail: failedStep.tail })
    anyFailed = true
  } else {
    results.push({ name: app.name, status: "PASS", detail: "clean" })
  }
}

console.log("\n\n============================================================")
console.log("  @inariwatch/capture — bundler compatibility matrix")
console.log("============================================================")
for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⚠️"
  console.log(`  ${icon}  ${r.name.padEnd(18)}  ${r.status.padEnd(6)}  ${r.detail}`)
  if (r.tail) {
    console.log(r.tail.split("\n").map((l) => `     │ ${l}`).join("\n"))
  }
}
console.log("============================================================\n")

process.exit(anyFailed ? 1 : 0)
