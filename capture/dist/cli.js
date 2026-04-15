#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync, exec } from "child_process";
import { createInterface } from "readline";
import { join, basename } from "path";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0] || "init";
function log(msg) { console.log(msg); }
function success(msg) { log(`${GREEN}+${RESET} ${msg}`); }
function warn(msg) { log(`${YELLOW}!${RESET} ${msg}`); }
function info(msg) { log(`${DIM}  ${msg}${RESET}`); }
function detectProject() {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) {
        log(`${YELLOW}No package.json found.${RESET} Run this inside a Node.js project.`);
        process.exit(1);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const usesTypescript = !!allDeps["typescript"] || existsSync(join(cwd, "tsconfig.json"));
    const hasSrcDir = existsSync(join(cwd, "src"));
    // Meta-frameworks first (they often include underlying tools as transitive deps).
    let framework = "node";
    if (allDeps["next"])
        framework = "nextjs";
    else if (allDeps["nuxt"] || allDeps["nuxt3"])
        framework = "nuxt";
    else if (allDeps["@remix-run/react"] || allDeps["@remix-run/node"] || allDeps["@remix-run/serve"])
        framework = "remix";
    else if (allDeps["@sveltejs/kit"])
        framework = "sveltekit";
    else if (allDeps["astro"])
        framework = "astro";
    else if (allDeps["fastify"])
        framework = "fastify";
    else if (allDeps["express"])
        framework = "express";
    else if (allDeps["vite"])
        framework = "vite";
    let packageManager = "npm";
    if (existsSync(join(cwd, "pnpm-lock.yaml")))
        packageManager = "pnpm";
    else if (existsSync(join(cwd, "yarn.lock")))
        packageManager = "yarn";
    else if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")))
        packageManager = "bun";
    return { framework, usesTypescript, hasSrcDir, packageManager };
}
// --- Install dependencies ---
function installDep(project, packageName = "@inariwatch/capture") {
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.dependencies?.[packageName] || pkg.devDependencies?.[packageName]) {
        info(`${packageName} already in dependencies`);
        return;
    }
    const cmd = project.packageManager === "yarn"
        ? `yarn add ${packageName}`
        : `${project.packageManager} install ${packageName}`;
    log(`\n${DIM}$ ${cmd}${RESET}`);
    try {
        execSync(cmd, { cwd, stdio: "inherit" });
        success(`Installed ${packageName}`);
    }
    catch {
        warn(`Could not auto-install. Run: ${cmd}`);
    }
}
// --- Interactive prompt helpers ---
function prompt(question, defaultValue = "") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
    return new Promise((resolve) => {
        rl.question(`${question}${suffix} `, (answer) => {
            rl.close();
            resolve(answer.trim() || defaultValue);
        });
    });
}
async function confirm(question, defaultYes = false) {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = (await prompt(`${question} ${DIM}[${hint}]${RESET}`)).toLowerCase();
    if (!answer)
        return defaultYes;
    return answer === "y" || answer === "yes";
}
// --- Next.js setup ---
function setupNextjs(project) {
    // 1. Add withInariWatch to next.config
    const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"];
    let configPath = null;
    let configContent = null;
    for (const f of configFiles) {
        const p = join(cwd, f);
        if (existsSync(p)) {
            configPath = p;
            configContent = readFileSync(p, "utf-8");
            break;
        }
    }
    if (!configPath || !configContent) {
        warn("No next.config found. Create one first.");
        return;
    }
    if (configContent.includes("@inariwatch/capture")) {
        info("next.config already has @inariwatch/capture");
    }
    else {
        // Add import at top
        const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`;
        let newContent = importLine + configContent;
        // Wrap the default export
        // Match: export default { ... }
        newContent = newContent.replace(/export default (\w+)/, "export default withInariWatch($1)");
        writeFileSync(configPath, newContent);
        success(`Updated ${configPath.replace(cwd, ".")} — added withInariWatch()`);
    }
    // 2. Create or update instrumentation file
    const ext = project.usesTypescript ? "ts" : "js";
    const instrDir = project.hasSrcDir ? join(cwd, "src") : cwd;
    const instrPath = join(instrDir, `instrumentation.${ext}`);
    if (existsSync(instrPath)) {
        const content = readFileSync(instrPath, "utf-8");
        if (content.includes("@inariwatch/capture")) {
            info("instrumentation file already has @inariwatch/capture");
            return;
        }
        // Prepend auto import
        writeFileSync(instrPath, `import "@inariwatch/capture/auto"\n\n${content}`);
        success(`Updated instrumentation.${ext} — added auto import`);
    }
    else {
        writeFileSync(instrPath, [
            `import "@inariwatch/capture/auto"`,
            `import { captureRequestError } from "@inariwatch/capture"`,
            ``,
            `export const onRequestError = captureRequestError`,
            ``,
        ].join("\n"));
        success(`Created instrumentation.${ext}`);
    }
}
// --- Replay setup (Next.js) ---
// Creates a client component that registers replayIntegration() on mount,
// adds NEXT_PUBLIC_INARIWATCH_PROJECT_ID placeholder to env files, and
// inserts <CaptureInit /> into app/layout.{tsx,jsx}.
const CAPTURE_INIT_COMPONENT = `"use client"

/**
 * Bootstraps @inariwatch/capture with session replay in the browser.
 * Generated by npx @inariwatch/capture init.
 *
 * Replay requires NEXT_PUBLIC_INARIWATCH_PROJECT_ID (UUID of the project
 * in your InariWatch dashboard). Without it, init no-ops safely.
 */
import { useEffect } from "react"

export function CaptureInit() {
  useEffect(() => {
    const w = window as unknown as { __INARIWATCH_INITIALIZED__?: boolean }
    if (w.__INARIWATCH_INITIALIZED__) return
    w.__INARIWATCH_INITIALIZED__ = true

    const projectId = process.env.NEXT_PUBLIC_INARIWATCH_PROJECT_ID
    if (!projectId) {
      console.warn("[@inariwatch/capture] NEXT_PUBLIC_INARIWATCH_PROJECT_ID missing — replay disabled.")
      return
    }

    void (async () => {
      try {
        const [{ init }, { replayIntegration }] = await Promise.all([
          import("@inariwatch/capture"),
          import("@inariwatch/capture-replay"),
        ])
        init({
          dsn: process.env.NEXT_PUBLIC_INARIWATCH_DSN,
          projectId,
          integrations: [replayIntegration()],
        })
      } catch (err) {
        console.warn("[@inariwatch/capture] replay init failed:", err)
      }
    })()
  }, [])

  return null
}
`;
function setupReplay(project) {
    if (project.framework !== "nextjs") {
        info("Replay scaffolding is Next.js-only for now — add replayIntegration() manually.");
        return;
    }
    // 1. Install capture-replay package
    installDep(project, "@inariwatch/capture-replay");
    // 2. Write the CaptureInit client component
    const ext = project.usesTypescript ? "tsx" : "jsx";
    const appDir = project.hasSrcDir ? join(cwd, "src", "app") : join(cwd, "app");
    if (!existsSync(appDir)) {
        warn(`No ${appDir.replace(cwd, ".")} directory found. Skipping replay scaffold.`);
        warn(`Add CaptureInit manually: see https://inariwatch.com/docs/session-replay`);
        return;
    }
    const componentPath = join(appDir, `capture-init.${ext}`);
    if (existsSync(componentPath)) {
        info(`capture-init.${ext} already exists — skipping`);
    }
    else {
        writeFileSync(componentPath, CAPTURE_INIT_COMPONENT);
        success(`Created ${componentPath.replace(cwd, ".")}`);
    }
    // 3. Insert <CaptureInit /> into the root layout, if we can find it
    const layoutPath = existsSync(join(appDir, `layout.${ext}`))
        ? join(appDir, `layout.${ext}`)
        : null;
    if (layoutPath) {
        const content = readFileSync(layoutPath, "utf-8");
        if (content.includes("CaptureInit")) {
            info(`layout.${ext} already imports CaptureInit`);
        }
        else {
            // Best-effort: add import at top and <CaptureInit /> right after <body>
            let next = `import { CaptureInit } from "./capture-init"\n${content}`;
            const bodyOpenRe = /<body[^>]*>/;
            if (bodyOpenRe.test(next)) {
                next = next.replace(bodyOpenRe, (match) => `${match}\n        <CaptureInit />`);
                writeFileSync(layoutPath, next);
                success(`Updated ${layoutPath.replace(cwd, ".")} — added <CaptureInit />`);
            }
            else {
                warn(`Could not auto-insert <CaptureInit /> into layout.${ext}. Add manually:`);
                log(`  import { CaptureInit } from "./capture-init"`);
                log(`  <body><CaptureInit />{children}</body>`);
            }
        }
    }
    // 4. Add NEXT_PUBLIC_INARIWATCH_PROJECT_ID placeholder to .env files
    const envFiles = [".env.local", ".env.example", ".env"];
    for (const envFile of envFiles) {
        const envPath = join(cwd, envFile);
        if (!existsSync(envPath))
            continue;
        const content = readFileSync(envPath, "utf-8");
        if (content.includes("NEXT_PUBLIC_INARIWATCH_PROJECT_ID"))
            continue;
        const base = content.endsWith("\n") ? content : content + "\n";
        const placeholder = envFile === ".env.example"
            ? "NEXT_PUBLIC_INARIWATCH_PROJECT_ID=your-project-uuid\n"
            : "# Paste your project UUID from https://app.inariwatch.com/projects\nNEXT_PUBLIC_INARIWATCH_PROJECT_ID=\n";
        writeFileSync(envPath, `${base}${placeholder}`);
        success(`Added NEXT_PUBLIC_INARIWATCH_PROJECT_ID placeholder to ${envFile}`);
    }
}
// --- Vite setup (covers Vite, Remix, SvelteKit) ---
const VITE_CONFIG_FILES = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
];
function findConfigFile(names) {
    for (const f of names) {
        const p = join(cwd, f);
        if (existsSync(p)) {
            return { path: p, content: readFileSync(p, "utf-8") };
        }
    }
    return null;
}
function setupVite(framework) {
    const found = findConfigFile(VITE_CONFIG_FILES);
    if (!found) {
        warn(`No vite.config found. Add manually:`);
        log(`  import { inariwatchVite } from "@inariwatch/capture/vite"`);
        log(`  plugins: [inariwatchVite(), ...]`);
        return;
    }
    if (found.content.includes("@inariwatch/capture")) {
        info(`${basename(found.path)} already has @inariwatch/capture`);
        return;
    }
    const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
    let newContent = importLine + found.content;
    // Try to insert into an existing `plugins: [ ... ]` array.
    const pluginsRegex = /plugins\s*:\s*\[/;
    if (pluginsRegex.test(newContent)) {
        newContent = newContent.replace(pluginsRegex, "plugins: [inariwatchVite(), ");
        writeFileSync(found.path, newContent);
        success(`Updated ${basename(found.path)} — added inariwatchVite() to plugins[]`);
    }
    else {
        warn(`Could not auto-insert plugin into ${basename(found.path)}. Add manually:`);
        log(`  import { inariwatchVite } from "@inariwatch/capture/vite"`);
        log(`  plugins: [inariwatchVite(), ...]`);
    }
    // Remix/SvelteKit apps typically don't need an instrumentation file — the
    // Vite plugin handles build-time injection and capture auto-inits at runtime.
    if (framework === "remix" || framework === "sveltekit") {
        info(`Add \`import "@inariwatch/capture/auto"\` at the top of your server entry.`);
    }
}
// --- Nuxt setup ---
function setupNuxt() {
    const nuxtConfigs = ["nuxt.config.ts", "nuxt.config.mjs", "nuxt.config.js"];
    const found = findConfigFile(nuxtConfigs);
    if (!found) {
        warn(`No nuxt.config found. Add manually:`);
        log(`  modules: ["@inariwatch/capture/nuxt"]`);
        return;
    }
    if (found.content.includes("@inariwatch/capture")) {
        info(`${basename(found.path)} already has @inariwatch/capture`);
        return;
    }
    const modulesRegex = /modules\s*:\s*\[/;
    let newContent;
    if (modulesRegex.test(found.content)) {
        newContent = found.content.replace(modulesRegex, `modules: ["@inariwatch/capture/nuxt", `);
    }
    else {
        // Insert a new modules array. Works for defineNuxtConfig({ ... }) form.
        const openBrace = /defineNuxtConfig\s*\(\s*\{/;
        if (openBrace.test(found.content)) {
            newContent = found.content.replace(openBrace, `defineNuxtConfig({\n  modules: ["@inariwatch/capture/nuxt"],`);
        }
        else {
            warn(`Could not auto-insert module into ${basename(found.path)}. Add manually:`);
            log(`  modules: ["@inariwatch/capture/nuxt"]`);
            return;
        }
    }
    writeFileSync(found.path, newContent);
    success(`Updated ${basename(found.path)} — added @inariwatch/capture/nuxt to modules[]`);
}
// --- Astro setup ---
function setupAstro() {
    const astroConfigs = ["astro.config.ts", "astro.config.mjs", "astro.config.js"];
    const found = findConfigFile(astroConfigs);
    if (!found) {
        warn(`No astro.config found. Add manually:`);
        log(`  import { inariwatchVite } from "@inariwatch/capture/vite"`);
        log(`  export default defineConfig({ vite: { plugins: [inariwatchVite()] } })`);
        return;
    }
    if (found.content.includes("@inariwatch/capture")) {
        info(`${basename(found.path)} already has @inariwatch/capture`);
        return;
    }
    const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
    let newContent = importLine + found.content;
    // Look for existing vite.plugins array inside the config.
    const vitePluginsRegex = /vite\s*:\s*\{\s*[^}]*plugins\s*:\s*\[/;
    if (vitePluginsRegex.test(newContent)) {
        newContent = newContent.replace(/plugins\s*:\s*\[/, "plugins: [inariwatchVite(), ");
        writeFileSync(found.path, newContent);
        success(`Updated ${basename(found.path)} — added inariwatchVite() to vite.plugins[]`);
        return;
    }
    // Look for an existing vite: { ... } block and inject plugins inside.
    const viteRegex = /vite\s*:\s*\{/;
    if (viteRegex.test(newContent)) {
        newContent = newContent.replace(viteRegex, "vite: {\n    plugins: [inariwatchVite()],");
        writeFileSync(found.path, newContent);
        success(`Updated ${basename(found.path)} — added vite.plugins with inariwatchVite()`);
        return;
    }
    warn(`Could not auto-insert plugin into ${basename(found.path)}. Add manually:`);
    log(`  import { inariwatchVite } from "@inariwatch/capture/vite"`);
    log(`  export default defineConfig({ vite: { plugins: [inariwatchVite()] } })`);
}
// --- Express / Node setup ---
function setupNode(project) {
    // Find entry file
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const mainFile = pkg.main || "index.js";
    const entryPath = join(cwd, mainFile);
    if (existsSync(entryPath)) {
        const content = readFileSync(entryPath, "utf-8");
        if (content.includes("@inariwatch/capture")) {
            info(`${mainFile} already has @inariwatch/capture`);
            return;
        }
        // Prepend auto import
        writeFileSync(entryPath, `import "@inariwatch/capture/auto"\n\n${content}`);
        success(`Updated ${mainFile} — added auto import`);
        return;
    }
    // Fallback: suggest --import flag
    log(`\n${BOLD}Add to your start script:${RESET}`);
    log(`  node --import @inariwatch/capture/auto ${mainFile}`);
    log(`\n${DIM}Or add to package.json scripts:${RESET}`);
    log(`  "start": "node --import @inariwatch/capture/auto ${mainFile}"`);
}
// --- DSN setup (device flow) ---
const API_BASE = process.env.INARIWATCH_API_URL ?? "https://app.inariwatch.com";
function openBrowser(url) {
    const cmd = process.platform === "darwin" ? `open "${url}"`
        : process.platform === "win32" ? `start "" "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, () => { });
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function pollForToken(code) {
    for (let i = 0; i < 60; i++) { // 60 × 2s = 2 min
        await sleep(2000);
        try {
            const res = await fetch(`${API_BASE}/api/cli/auth/poll?code=${code}`);
            const data = await res.json();
            if (data.status === "approved" && data.apiToken)
                return data.apiToken;
            if (data.status === "expired") {
                warn("Authorization expired. Run again.");
                return null;
            }
        }
        catch { /* network blip, keep trying */ }
    }
    warn("Authorization timed out. Run again.");
    return null;
}
async function fetchDsn(apiToken, projectName) {
    try {
        const res = await fetch(`${API_BASE}/api/cli/link`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
            body: JSON.stringify({ projectName }),
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        return data.dsn ?? null;
    }
    catch {
        return null;
    }
}
function writeDsnToEnv(dsn) {
    for (const envFile of [".env.local", ".env"]) {
        const envPath = join(cwd, envFile);
        if (existsSync(envPath)) {
            const content = readFileSync(envPath, "utf-8");
            if (content.includes("INARIWATCH_DSN")) {
                info(`INARIWATCH_DSN already in ${envFile} — skipping`);
                return;
            }
            const base = content.endsWith("\n") ? content : content + "\n";
            writeFileSync(envPath, `${base}INARIWATCH_DSN=${dsn}\n`);
            success(`Written INARIWATCH_DSN to ${envFile}`);
            return;
        }
    }
    writeFileSync(join(cwd, ".env"), `INARIWATCH_DSN=${dsn}\n`);
    success("Created .env with INARIWATCH_DSN");
}
async function setupDsn(projectName) {
    // Skip if DSN already configured
    for (const envFile of [".env.local", ".env"]) {
        const envPath = join(cwd, envFile);
        if (existsSync(envPath) && readFileSync(envPath, "utf-8").includes("INARIWATCH_DSN")) {
            info("INARIWATCH_DSN already configured");
            return;
        }
    }
    log(`\n${DIM}Connecting to InariWatch...${RESET}`);
    let startData;
    try {
        const res = await fetch(`${API_BASE}/api/cli/auth/start`, { method: "POST" });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        startData = await res.json();
    }
    catch {
        warn(`Could not reach InariWatch. Set ${CYAN}INARIWATCH_DSN${RESET} manually.`);
        return;
    }
    log(`\n${BOLD}Open this URL to authorize:${RESET}`);
    log(`  ${CYAN}${startData.verifyUrl}${RESET}\n`);
    openBrowser(startData.verifyUrl);
    log(`${DIM}Waiting for authorization in browser...${RESET}`);
    const apiToken = await pollForToken(startData.code);
    if (!apiToken)
        return;
    const dsn = await fetchDsn(apiToken, projectName);
    if (!dsn) {
        warn("Could not create project. Set INARIWATCH_DSN manually.");
        return;
    }
    writeDsnToEnv(dsn);
    success(`Connected to InariWatch (project: ${projectName})`);
}
// --- Print results ---
function printDone(dsnConfigured) {
    log(`\n${GREEN}${BOLD}Done.${RESET} InariWatch is active.\n`);
    if (!dsnConfigured) {
        log(`${DIM}Cloud mode:${RESET} Set ${CYAN}INARIWATCH_DSN${RESET} env var to send errors to your dashboard.`);
        log(``);
    }
}
// --- Main ---
async function main() {
    log(`\n${BOLD}@inariwatch/capture${RESET}\n`);
    if (command !== "init") {
        log(`${BOLD}Usage:${RESET}`);
        log(`  npx @inariwatch/capture   ${DIM}# Auto-setup in your project${RESET}`);
        log(``);
        return;
    }
    const project = detectProject();
    log(`${DIM}Detected:${RESET} ${BOLD}${project.framework}${RESET} ${project.usesTypescript ? "(TypeScript)" : "(JavaScript)"} ${DIM}via ${project.packageManager}${RESET}\n`);
    installDep(project);
    log("");
    switch (project.framework) {
        case "nextjs":
            setupNextjs(project);
            break;
        case "nuxt":
            setupNuxt();
            break;
        case "remix":
        case "sveltekit":
        case "vite":
            setupVite(project.framework);
            break;
        case "astro":
            setupAstro();
            break;
        case "fastify":
        case "express":
        case "node":
        default: setupNode(project);
    }
    // Session replay is opt-in — it adds ~150 KB (rrweb) to client bundles and
    // ~$0.30/mo per active project in R2 storage. Ask once, save preference.
    log("");
    if (project.framework === "nextjs") {
        const wantsReplay = await confirm(`${BOLD}Enable session replay?${RESET} ${DIM}(adds ~150 KB, lets you replay user sessions that triggered errors)${RESET}`, false);
        if (wantsReplay) {
            log("");
            setupReplay(project);
        }
    }
    const projectName = basename(cwd);
    await setupDsn(projectName);
    const hasDsn = [".env.local", ".env"].some(f => {
        const p = join(cwd, f);
        return existsSync(p) && readFileSync(p, "utf-8").includes("INARIWATCH_DSN");
    });
    printDone(hasDsn);
}
main().catch(console.error);
//# sourceMappingURL=cli.js.map