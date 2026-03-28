#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import { join, resolve } from "path"
import { createInterface } from "readline"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const cwd = process.cwd()
const args = process.argv.slice(2)
const command = args[0] || "init"

function log(msg: string) {
  console.log(msg)
}

function success(msg: string) {
  log(`${GREEN}+${RESET} ${msg}`)
}

function warn(msg: string) {
  log(`${YELLOW}!${RESET} ${msg}`)
}

function info(msg: string) {
  log(`${DIM}  ${msg}${RESET}`)
}

// --- Framework detection ---

type Framework = "nextjs" | "express" | "node"

interface DetectedProject {
  framework: Framework
  packageJson: Record<string, unknown>
  usesTypescript: boolean
  hasSrcDir: boolean
}

function detectProject(): DetectedProject {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) {
    log(`${YELLOW}No package.json found.${RESET} Run this inside a Node.js project.`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const usesTypescript = !!allDeps["typescript"] || existsSync(join(cwd, "tsconfig.json"))
  const hasSrcDir = existsSync(join(cwd, "src"))

  let framework: Framework = "node"
  if (allDeps["next"]) framework = "nextjs"
  else if (allDeps["express"]) framework = "express"

  return { framework, packageJson: pkg, usesTypescript, hasSrcDir }
}

// --- Code generation ---

function nextjsInstrumentation(ts: boolean): string {
  const ext = ts ? "ts" : "js"
  return `import { init, captureRequestError } from "@inariwatch/capture"

init({})

export const onRequestError = captureRequestError
`
}

function expressSetup(ts: boolean): string {
  return `import { init, captureException } from "@inariwatch/capture"

// Initialize InariWatch — works locally with no DSN
init({})

// Add this as your LAST middleware:
// app.use((err${ts ? ": Error" : ""}, req${ts ? ": any" : ""}, res${ts ? ": any" : ""}, next${ts ? ": any" : ""}) => {
//   captureException(err, { request: { method: req.method, url: req.url } })
//   next(err)
// })
`
}

function nodeSetup(): string {
  return `import { init, captureException } from "@inariwatch/capture"

// Initialize InariWatch — works locally with no DSN
init({})

// Catch unhandled errors globally
process.on("uncaughtException", (err) => {
  captureException(err)
  console.error(err)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) captureException(reason)
  console.error("Unhandled rejection:", reason)
})
`
}

// --- File injection ---

function injectNextjs(project: DetectedProject) {
  const ext = project.usesTypescript ? "ts" : "js"

  // Check for app dir
  const appDir = project.hasSrcDir ? join(cwd, "src") : cwd
  const instrPath = join(appDir, `instrumentation.${ext}`)

  if (existsSync(instrPath)) {
    const content = readFileSync(instrPath, "utf-8")
    if (content.includes("@inariwatch/capture")) {
      warn("Already installed — instrumentation file has @inariwatch/capture")
      return
    }
    // Prepend init to existing instrumentation
    const newContent = `import { init } from "@inariwatch/capture"\ninit({})\n\n${content}`
    writeFileSync(instrPath, newContent)
    success(`Updated ${instrPath}`)
  } else {
    writeFileSync(instrPath, nextjsInstrumentation(project.usesTypescript))
    success(`Created ${instrPath}`)
  }

  // Check next.config for instrumentationHook
  const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"]
  for (const cfg of configFiles) {
    const cfgPath = join(cwd, cfg)
    if (existsSync(cfgPath)) {
      const content = readFileSync(cfgPath, "utf-8")
      if (!content.includes("instrumentationHook")) {
        warn(`Add ${BOLD}experimental: { instrumentationHook: true }${RESET} to ${cfg} if on Next.js < 15`)
      }
      break
    }
  }
}

function injectExpress(project: DetectedProject) {
  const ext = project.usesTypescript ? "ts" : "js"
  const setupPath = join(cwd, project.hasSrcDir ? "src" : "", `inariwatch.${ext}`)

  if (existsSync(setupPath)) {
    warn("Already installed — inariwatch setup file exists")
    return
  }

  writeFileSync(setupPath, expressSetup(project.usesTypescript))
  success(`Created ${setupPath}`)
  info(`Import it at the top of your entry file:`)
  info(`  import "./inariwatch${project.hasSrcDir ? "" : ""}"`)
}

function injectNode(project: DetectedProject) {
  const ext = project.usesTypescript ? "ts" : "js"
  const setupPath = join(cwd, project.hasSrcDir ? "src" : "", `inariwatch.${ext}`)

  if (existsSync(setupPath)) {
    warn("Already installed — inariwatch setup file exists")
    return
  }

  writeFileSync(setupPath, nodeSetup())
  success(`Created ${setupPath}`)
  info(`Import it at the top of your entry file:`)
  info(`  import "./inariwatch"`)
}

// --- Install dependency ---

function installDependency() {
  const pkgPath = join(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const deps = pkg.dependencies || {}

  if (deps["@inariwatch/capture"]) {
    info("@inariwatch/capture already in dependencies")
    return
  }

  // Detect package manager
  let pm = "npm"
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) pm = "pnpm"
  else if (existsSync(join(cwd, "yarn.lock"))) pm = "yarn"
  else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) pm = "bun"

  const installCmd = pm === "yarn"
    ? "yarn add @inariwatch/capture"
    : `${pm} install @inariwatch/capture`

  log(`\n${DIM}$ ${installCmd}${RESET}`)
  try {
    execSync(installCmd, { cwd, stdio: "inherit" })
    success("Installed @inariwatch/capture")
  } catch {
    warn("Could not auto-install. Run manually:")
    info(`  ${installCmd}`)
  }
}

// --- Link command ---

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function linkToCloud() {
  log(`\n${BOLD}Link to InariWatch Cloud${RESET}\n`)
  log(`Get your DSN from ${CYAN}https://app.inariwatch.com${RESET}`)
  log(`Project Settings > Integrations > Capture SDK\n`)

  const dsn = await ask(`${BOLD}Paste your DSN:${RESET} `)

  if (!dsn) {
    warn("No DSN provided. You can add it later.")
    return
  }

  // Validate DSN format
  try {
    new URL(dsn)
  } catch {
    warn("Invalid DSN URL. Check the format and try again.")
    return
  }

  // Find and update init() calls
  const patterns = [
    "instrumentation.ts", "instrumentation.js",
    "src/instrumentation.ts", "src/instrumentation.js",
    "inariwatch.ts", "inariwatch.js",
    "src/inariwatch.ts", "src/inariwatch.js",
  ]

  let updated = false
  for (const pattern of patterns) {
    const filePath = join(cwd, pattern)
    if (!existsSync(filePath)) continue

    let content = readFileSync(filePath, "utf-8")
    if (content.includes("init({})") || content.includes("init({ })")) {
      content = content.replace(/init\(\{\s*\}\)/, `init({ dsn: "${dsn}" })`)
      writeFileSync(filePath, content)
      success(`Updated DSN in ${pattern}`)
      updated = true
      break
    } else if (content.includes("@inariwatch/capture") && !content.includes("dsn:")) {
      // Has capture but no DSN — add it
      content = content.replace(/init\(\{/, `init({ dsn: "${dsn}",`)
      writeFileSync(filePath, content)
      success(`Added DSN to ${pattern}`)
      updated = true
      break
    }
  }

  if (!updated) {
    warn("Could not find init() call to update. Add the DSN manually:")
    info(`  init({ dsn: "${dsn}" })`)
  }

  log(`\n${GREEN}Linked!${RESET} Errors now go to your InariWatch dashboard.`)
}

// --- Local mode info ---

function printLocalModeInfo() {
  log(`\n${BOLD}Local mode active${RESET} ${DIM}(no DSN)${RESET}`)
  log(`Errors will print to your terminal with full stack traces.`)
  log(`\nWhen you're ready for the cloud dashboard:`)
  log(`  ${CYAN}npx @inariwatch/capture link${RESET}`)
}

// --- Main ---

async function main() {
  log(`\n${BOLD}@inariwatch/capture${RESET}\n`)

  if (command === "link") {
    await linkToCloud()
    return
  }

  if (command === "init" || command === undefined) {
    const project = detectProject()

    log(`${DIM}Detected:${RESET} ${BOLD}${project.framework}${RESET} ${project.usesTypescript ? "(TypeScript)" : "(JavaScript)"}\n`)

    // Install dependency
    installDependency()

    // Inject code
    log("")
    switch (project.framework) {
      case "nextjs":
        injectNextjs(project)
        break
      case "express":
        injectExpress(project)
        break
      default:
        injectNode(project)
    }

    printLocalModeInfo()
    log("")
    return
  }

  // Unknown command
  log(`${BOLD}Usage:${RESET}`)
  log(`  npx @inariwatch/capture          ${DIM}# Auto-setup in your project${RESET}`)
  log(`  npx @inariwatch/capture link      ${DIM}# Connect to InariWatch cloud${RESET}`)
  log("")
}

main().catch(console.error)
