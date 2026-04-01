"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProject = detectProject;
exports.installCapture = installCapture;
exports.promptSubstrate = promptSubstrate;
const fs_1 = require("fs");
const path_1 = require("path");
const child_process_1 = require("child_process");
const readline_1 = require("readline");
function detectProject(cwd = process.cwd()) {
    const pkgPath = (0, path_1.join)(cwd, "package.json");
    if (!(0, fs_1.existsSync)(pkgPath))
        return null;
    let pkg;
    try {
        pkg = JSON.parse((0, fs_1.readFileSync)(pkgPath, "utf8"));
    }
    catch {
        return null;
    }
    const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
    };
    const hasCapture = "@inariwatch/capture" in deps;
    // Detect framework
    let type = "node";
    if ("next" in deps)
        type = "nextjs";
    // Detect package manager
    let packageManager = "npm";
    if ((0, fs_1.existsSync)((0, path_1.join)(cwd, "bun.lockb")) || (0, fs_1.existsSync)((0, path_1.join)(cwd, "bun.lock")))
        packageManager = "bun";
    else if ((0, fs_1.existsSync)((0, path_1.join)(cwd, "pnpm-lock.yaml")))
        packageManager = "pnpm";
    else if ((0, fs_1.existsSync)((0, path_1.join)(cwd, "yarn.lock")))
        packageManager = "yarn";
    return { type, hasCapture, packageManager };
}
function installCapture(project, cwd = process.cwd()) {
    if (project.hasCapture)
        return { ok: true }; // Already installed
    // Install the package
    const installCmd = {
        npm: "npm install @inariwatch/capture",
        yarn: "yarn add @inariwatch/capture",
        pnpm: "pnpm add @inariwatch/capture",
        bun: "bun add @inariwatch/capture",
    }[project.packageManager];
    try {
        (0, child_process_1.execSync)(installCmd, { cwd, stdio: "pipe" });
    }
    catch (e) {
        return { ok: false, error: `Failed to install: ${e instanceof Error ? e.message : "unknown"}` };
    }
    // Framework-specific setup
    if (project.type === "nextjs") {
        return setupNextjs(cwd);
    }
    return { ok: true };
}
function setupNextjs(cwd) {
    // Create instrumentation.ts if it doesn't exist
    const instrumentationPath = (0, path_1.join)(cwd, "instrumentation.ts");
    if (!(0, fs_1.existsSync)(instrumentationPath)) {
        (0, fs_1.writeFileSync)(instrumentationPath, `import "@inariwatch/capture/auto"\nimport { captureRequestError } from "@inariwatch/capture"\nexport const onRequestError = captureRequestError\n`);
    }
    // Wrap next.config — detect .ts, .mjs, .js
    const configFiles = ["next.config.ts", "next.config.mjs", "next.config.js"];
    for (const file of configFiles) {
        const configPath = (0, path_1.join)(cwd, file);
        if (!(0, fs_1.existsSync)(configPath))
            continue;
        const content = (0, fs_1.readFileSync)(configPath, "utf8");
        if (content.includes("withInariWatch"))
            break; // Already wrapped
        // Add import and wrap
        const isTs = file.endsWith(".ts");
        const isMjs = file.endsWith(".mjs");
        if (isTs || isMjs) {
            // ESM: add import at top, wrap default export
            const importLine = `import { withInariWatch } from "@inariwatch/capture/next"\n`;
            if (content.includes("export default")) {
                // Wrap: export default X → export default withInariWatch(X)
                const wrapped = importLine + content.replace(/export default (.+)/, (_, exported) => {
                    // Handle multiline: export default { ... } or export default nextConfig
                    const trimmed = exported.trim();
                    if (trimmed.endsWith(";")) {
                        return `export default withInariWatch(${trimmed.slice(0, -1)});`;
                    }
                    return `export default withInariWatch(${trimmed})`;
                });
                (0, fs_1.writeFileSync)(configPath, wrapped);
            }
        }
        else {
            // CJS: add require, wrap module.exports
            const requireLine = `const { withInariWatch } = require("@inariwatch/capture/next")\n`;
            if (content.includes("module.exports")) {
                const wrapped = requireLine + content.replace(/module\.exports\s*=\s*/, "module.exports = withInariWatch(") + ")";
                (0, fs_1.writeFileSync)(configPath, wrapped);
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
async function promptSubstrate(cwd = process.cwd()) {
    // Check if already enabled in any .env file
    const envFiles = [".env.local", ".env"];
    for (const f of envFiles) {
        const p = (0, path_1.join)(cwd, f);
        if ((0, fs_1.existsSync)(p) && (0, fs_1.readFileSync)(p, "utf8").includes("INARIWATCH_SUBSTRATE")) {
            return false; // Already configured
        }
    }
    const answer = await ask("  Enable Substrate I/O recording? (y/N) ");
    if (answer.toLowerCase() !== "y")
        return false;
    // Write to .env.local (preferred) or .env
    const targetEnv = (0, fs_1.existsSync)((0, path_1.join)(cwd, ".env.local")) ? ".env.local" : ".env";
    const envPath = (0, path_1.join)(cwd, targetEnv);
    const content = (0, fs_1.existsSync)(envPath) ? (0, fs_1.readFileSync)(envPath, "utf8") : "";
    const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    (0, fs_1.appendFileSync)(envPath, `${newline}INARIWATCH_SUBSTRATE=true\n`);
    return true;
}
function ask(question) {
    const rl = (0, readline_1.createInterface)({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
