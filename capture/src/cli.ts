#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const cwd = process.cwd()
const args = process.argv.slice(2)
const command = args[0] || "init"

function log(msg: string) { console.log(msg) }
function success(msg: string) { log(`${GREEN}+${RESET} ${msg}`) }
function warn(msg: string) { log(`${YELLOW}!${RESET} ${msg}`) }
function info(msg: string) { log(`${DIM}  ${msg}${RESET}`) }

// --- Framework detection ---

type Framework = "nextjs" | "express" | "node"

interface DetectedProject {
  framework: Framework
  usesTypescript: boolean
  hasSrcDir: boolean
  packageManager: string
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

  let packageManager = "npm"
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm"
  else if (existsSync(join(cwd, "yarn.lock"))) packageManager = "yarn"
  else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) packageManager = "bun"

  return { framework, usesTypescript, hasSrcDir, packageManager }
}

// --- Install dependency ---

function installDep(project: DetectedProject) {
  const pkgPath = join(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  if (pkg.dependencies?.["@inariwatch/capture"]) {
    info("@inariwatch/capture already in dependencies")
    return
  }

  const cmd = project.packageManager === "yarn"
    ? "yarn add @inariwatch/capture"
    : `${project.packageManager} install @inariwatch/capture`

  log(`\n${DIM}$ ${cmd}${RESET}`)
  try {
    execSync(cmd, { cwd, stdio: "inherit" })
    success("Installed @inariwatch/capture")
  } catch {
    warn(`Could not auto-install. Run: ${cmd}`)
  }
}

// --- Next.js setup ---

function setupNextjs(project: DetectedProject) {
  // 1. Add withInariWatch to next.config
  const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"]
  let configPath: string | null = null
  let configContent: string | null = null

  for (const f of configFiles) {
    const p = join(cwd, f)
    if (existsSync(p)) {
      configPath = p
      configContent = readFileSync(p, "utf-8")
      break
    }
  }

  if (!configPath || !configContent) {
    warn("No next.config found. Create one first.")
    return
  }

  if (configContent.includes("@inariwatch/capture")) {
    info("next.config already has @inariwatch/capture")
  } else {
    // Add import at top
    const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`
    let newContent = importLine + configContent

    // Wrap the default export
    // Match: export default { ... }
    newContent = newContent.replace(
      /export default (\w+)/,
      "export default withInariWatch($1)"
    )

    writeFileSync(configPath, newContent)
    success(`Updated ${configPath.replace(cwd, ".")} — added withInariWatch()`)
  }

  // 2. Create or update instrumentation file
  const ext = project.usesTypescript ? "ts" : "js"
  const instrDir = project.hasSrcDir ? join(cwd, "src") : cwd
  const instrPath = join(instrDir, `instrumentation.${ext}`)

  if (existsSync(instrPath)) {
    const content = readFileSync(instrPath, "utf-8")
    if (content.includes("@inariwatch/capture")) {
      info("instrumentation file already has @inariwatch/capture")
      return
    }
    // Prepend auto import
    writeFileSync(instrPath, `import "@inariwatch/capture/auto"\n\n${content}`)
    success(`Updated instrumentation.${ext} — added auto import`)
  } else {
    writeFileSync(instrPath, [
      `import "@inariwatch/capture/auto"`,
      `import { captureRequestError } from "@inariwatch/capture"`,
      ``,
      `export const onRequestError = captureRequestError`,
      ``,
    ].join("\n"))
    success(`Created instrumentation.${ext}`)
  }
}

// --- Express / Node setup ---

function setupNode(project: DetectedProject) {
  // Find entry file
  const pkgPath = join(cwd, "package.json")
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const mainFile = pkg.main || "index.js"

  const entryPath = join(cwd, mainFile)
  if (existsSync(entryPath)) {
    const content = readFileSync(entryPath, "utf-8")
    if (content.includes("@inariwatch/capture")) {
      info(`${mainFile} already has @inariwatch/capture`)
      return
    }
    // Prepend auto import
    writeFileSync(entryPath, `import "@inariwatch/capture/auto"\n\n${content}`)
    success(`Updated ${mainFile} — added auto import`)
    return
  }

  // Fallback: suggest --import flag
  log(`\n${BOLD}Add to your start script:${RESET}`)
  log(`  node --import @inariwatch/capture/auto ${mainFile}`)
  log(`\n${DIM}Or add to package.json scripts:${RESET}`)
  log(`  "start": "node --import @inariwatch/capture/auto ${mainFile}"`)
}

// --- Print results ---

function printDone() {
  log(`\n${GREEN}${BOLD}Done.${RESET} InariWatch is active.\n`)
  log(`${DIM}Local mode:${RESET} Errors print to your terminal. No account needed.`)
  log(`${DIM}Cloud mode:${RESET} Set ${CYAN}INARIWATCH_DSN${RESET} env var to send to dashboard.`)
  log(``)
  log(`${DIM}  # .env${RESET}`)
  log(`${DIM}  INARIWATCH_DSN=https://app.inariwatch.com/api/webhooks/capture/YOUR_ID${RESET}`)
  log(``)
}

// --- Main ---

function main() {
  log(`\n${BOLD}@inariwatch/capture${RESET}\n`)

  if (command !== "init") {
    log(`${BOLD}Usage:${RESET}`)
    log(`  npx @inariwatch/capture   ${DIM}# Auto-setup in your project${RESET}`)
    log(``)
    return
  }

  const project = detectProject()
  log(`${DIM}Detected:${RESET} ${BOLD}${project.framework}${RESET} ${project.usesTypescript ? "(TypeScript)" : "(JavaScript)"} ${DIM}via ${project.packageManager}${RESET}\n`)

  installDep(project)
  log("")

  switch (project.framework) {
    case "nextjs":
      setupNextjs(project)
      break
    default:
      setupNode(project)
  }

  printDone()
}

main()
