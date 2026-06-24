import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createInterface } from "readline";
export function detectProject(cwd = process.cwd()) {
    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath))
        return null;
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    }
    catch {
        return null;
    }
    const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
    };
    const hasCapture = "@inariwatch/capture" in deps;
    // Detect framework — meta-frameworks before libs, since meta-frameworks often
    // pull in underlying tools (vite, etc.) as transitive deps.
    let type = "node";
    if ("next" in deps)
        type = "nextjs";
    else if ("nuxt" in deps || "nuxt3" in deps)
        type = "nuxt";
    else if ("@remix-run/react" in deps || "@remix-run/node" in deps || "@remix-run/serve" in deps)
        type = "remix";
    else if ("@sveltejs/kit" in deps)
        type = "sveltekit";
    else if ("astro" in deps)
        type = "astro";
    else if ("fastify" in deps)
        type = "fastify";
    else if ("express" in deps)
        type = "express";
    else if ("vite" in deps)
        type = "vite";
    // Detect package manager
    let packageManager = "npm";
    if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")))
        packageManager = "bun";
    else if (existsSync(join(cwd, "pnpm-lock.yaml")))
        packageManager = "pnpm";
    else if (existsSync(join(cwd, "yarn.lock")))
        packageManager = "yarn";
    return { type, hasCapture, packageManager };
}
export function installCapture(project, cwd = process.cwd()) {
    if (project.hasCapture)
        return { ok: true }; // Already installed
    // Install the package
    const pkg = "@inariwatch/capture@^0.6.0";
    const installCmd = {
        npm: `npm install ${pkg}`,
        yarn: `yarn add ${pkg}`,
        pnpm: `pnpm add ${pkg}`,
        bun: `bun add ${pkg}`,
    }[project.packageManager];
    try {
        execSync(installCmd, { cwd, stdio: "pipe" });
    }
    catch (e) {
        return { ok: false, error: `Failed to install: ${e instanceof Error ? e.message : "unknown"}` };
    }
    // Framework-specific setup
    switch (project.type) {
        case "nextjs": return setupNextjs(cwd);
        case "nuxt": return setupNuxt(cwd);
        case "remix":
        case "sveltekit":
        case "vite": return setupVite(cwd);
        case "astro": return setupAstro(cwd);
        case "fastify":
        case "express":
        case "node":
        case "unknown":
        default: return setupNodeEntry(cwd);
    }
}
function findConfigFile(cwd, names) {
    for (const name of names) {
        const p = join(cwd, name);
        if (existsSync(p)) {
            return { path: p, content: readFileSync(p, "utf8") };
        }
    }
    return null;
}
function setupVite(cwd) {
    const found = findConfigFile(cwd, [
        "vite.config.ts",
        "vite.config.mts",
        "vite.config.js",
        "vite.config.mjs",
        "vite.config.cjs",
    ]);
    if (!found)
        return { ok: true }; // Leave config alone if none present.
    if (found.content.includes("@inariwatch/capture"))
        return { ok: true };
    const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
    let newContent = importLine + found.content;
    const pluginsRegex = /plugins\s*:\s*\[/;
    if (pluginsRegex.test(newContent)) {
        newContent = newContent.replace(pluginsRegex, "plugins: [inariwatchVite(), ");
        writeFileSync(found.path, newContent);
    }
    return { ok: true };
}
function setupNuxt(cwd) {
    const found = findConfigFile(cwd, ["nuxt.config.ts", "nuxt.config.mjs", "nuxt.config.js"]);
    if (!found)
        return { ok: true };
    if (found.content.includes("@inariwatch/capture"))
        return { ok: true };
    const modulesRegex = /modules\s*:\s*\[/;
    let newContent;
    if (modulesRegex.test(found.content)) {
        newContent = found.content.replace(modulesRegex, `modules: ["@inariwatch/capture/nuxt", `);
    }
    else {
        const openBrace = /defineNuxtConfig\s*\(\s*\{/;
        if (!openBrace.test(found.content))
            return { ok: true };
        newContent = found.content.replace(openBrace, `defineNuxtConfig({\n  modules: ["@inariwatch/capture/nuxt"],`);
    }
    writeFileSync(found.path, newContent);
    return { ok: true };
}
function setupAstro(cwd) {
    const found = findConfigFile(cwd, ["astro.config.ts", "astro.config.mjs", "astro.config.js"]);
    if (!found)
        return { ok: true };
    if (found.content.includes("@inariwatch/capture"))
        return { ok: true };
    const importLine = `import { inariwatchVite } from "@inariwatch/capture/vite"\n`;
    let newContent = importLine + found.content;
    // Existing vite.plugins array: inject into it.
    const vitePluginsRegex = /vite\s*:\s*\{[^}]*plugins\s*:\s*\[/;
    if (vitePluginsRegex.test(newContent)) {
        newContent = newContent.replace(/plugins\s*:\s*\[/, "plugins: [inariwatchVite(), ");
        writeFileSync(found.path, newContent);
        return { ok: true };
    }
    // Existing vite block without plugins: add plugins inside it.
    const viteRegex = /vite\s*:\s*\{/;
    if (viteRegex.test(newContent)) {
        newContent = newContent.replace(viteRegex, "vite: {\n    plugins: [inariwatchVite()],");
        writeFileSync(found.path, newContent);
    }
    return { ok: true };
}
function setupNodeEntry(cwd) {
    // For plain Node, Express, Fastify: rely on `--import @inariwatch/capture/auto`
    // flag in the start script. We don't mutate source files — too risky to guess
    // the entry point. The CLI output and docs tell the user how to wire it.
    void cwd;
    return { ok: true };
}
function setupNextjs(cwd) {
    // Create instrumentation.ts if it doesn't exist
    const instrumentationPath = join(cwd, "instrumentation.ts");
    if (!existsSync(instrumentationPath)) {
        writeFileSync(instrumentationPath, `import "@inariwatch/capture/auto"\nimport { captureRequestError } from "@inariwatch/capture"\nexport const onRequestError = captureRequestError\n`);
    }
    // Wrap next.config — detect .ts, .mjs, .js
    const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"];
    for (const file of configFiles) {
        const configPath = join(cwd, file);
        if (!existsSync(configPath))
            continue;
        const content = readFileSync(configPath, "utf8");
        if (content.includes("withInariWatch"))
            break; // Already wrapped
        // Add import and wrap
        const isTs = file.endsWith(".ts");
        const isMjs = file.endsWith(".mjs");
        if (isTs || isMjs) {
            // ESM: extract default export into variable, re-export wrapped
            if (content.includes("export default")) {
                const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`;
                const wrapped = importLine +
                    content.replace("export default ", "const _nextConfig = ") +
                    "\nexport default withInariWatch(_nextConfig);\n";
                writeFileSync(configPath, wrapped);
            }
        }
        else {
            // CJS: extract module.exports into variable, re-export wrapped
            if (content.includes("module.exports")) {
                const requireLine = `const { withInariWatch } = require("@inariwatch/capture/next")\n`;
                const wrapped = requireLine +
                    content.replace(/module\.exports\s*=\s*/, "const _nextConfig = ") +
                    "\nmodule.exports = withInariWatch(_nextConfig);\n";
                writeFileSync(configPath, wrapped);
            }
        }
        break;
    }
    return { ok: true };
}
/**
 * Prompt the user to enable Substrate I/O recording.
 * Returns true if enabled, false if skipped.
 */
export async function promptSubstrate(cwd = process.cwd()) {
    // Check if already enabled in any .env file
    const envFiles = [".env.local", ".env"];
    for (const f of envFiles) {
        const p = join(cwd, f);
        if (existsSync(p) && readFileSync(p, "utf8").includes("INARIWATCH_SUBSTRATE")) {
            return false; // Already configured
        }
    }
    const answer = await ask("  Enable Substrate I/O recording? (y/N) ");
    if (answer.toLowerCase() !== "y")
        return false;
    // Write to .env.local (preferred) or .env
    const targetEnv = existsSync(join(cwd, ".env.local")) ? ".env.local" : ".env";
    const envPath = join(cwd, targetEnv);
    const content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    appendFileSync(envPath, `${newline}INARIWATCH_SUBSTRATE=true\n`);
    return true;
}
export function ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.on("close", () => resolve(""));
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
