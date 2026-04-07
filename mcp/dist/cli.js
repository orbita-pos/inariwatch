#!/usr/bin/env node
import { detectTools, detectGitHub } from "./detect.js";
import { configureTools } from "./configure.js";
import { deviceAuth } from "./auth.js";
import { detectProject, installCapture, promptSubstrate, ask } from "./capture.js";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const skipCapture = args.includes("--no-capture");
    if (command !== "init" && command !== undefined) {
        console.log(`\n  ${BOLD}@inariwatch/mcp${RESET}\n`);
        console.log(`  Usage: npx @inariwatch/mcp init [options]\n`);
        console.log(`  Options:`);
        console.log(`    --token <t>     Use a specific token instead of browser auth`);
        console.log(`    --no-capture    Skip @inariwatch/capture SDK installation\n`);
        process.exit(0);
    }
    console.log(`\n  ${BOLD}InariWatch Setup${RESET}\n`);
    // ── 1. Detect AI tools ──
    console.log(`  ${DIM}AI tools${RESET}\n`);
    const tools = detectTools();
    const detected = tools.filter((t) => t.detected);
    const notFound = tools.filter((t) => !t.detected);
    for (const t of detected) {
        const ver = t.version ? ` ${DIM}(${t.version})${RESET}` : "";
        console.log(`    ${GREEN}✓${RESET} ${t.name}${ver}`);
    }
    for (const t of notFound) {
        console.log(`    ${DIM}✗ ${t.name}${RESET}`);
    }
    // ── 2. Detect GitHub ──
    const github = detectGitHub();
    if (github) {
        console.log(`    ${GREEN}✓${RESET} GitHub CLI ${DIM}(${github.user})${RESET}`);
    }
    // ── 3. Detect project ──
    const project = detectProject();
    console.log("");
    if (project && !skipCapture) {
        const framework = project.type === "nextjs" ? "Next.js" : "Node.js";
        if (project.hasCapture) {
            console.log(`  ${DIM}Project${RESET}\n`);
            console.log(`    ${GREEN}✓${RESET} ${framework} — @inariwatch/capture already installed`);
        }
        else {
            console.log(`  ${DIM}Project${RESET}\n`);
            console.log(`    ${YELLOW}●${RESET} ${framework} detected — will install @inariwatch/capture`);
        }
        console.log("");
    }
    if (detected.length === 0 && !project) {
        console.log(`  ${RED}Nothing detected.${RESET} Run this from a Node.js project or install an AI tool first.\n`);
        process.exit(1);
    }
    // ── 3. Authenticate ──
    const tokenFlag = args.indexOf("--token");
    let token = null;
    if (tokenFlag !== -1 && args[tokenFlag + 1]) {
        token = args[tokenFlag + 1];
        if (!token.startsWith("inari_")) {
            console.log(`  ${RED}Invalid token.${RESET} Tokens start with "inari_". Get one at app.inariwatch.com/settings\n`);
            process.exit(1);
        }
        console.log(`  ${GREEN}✓${RESET} Using provided token`);
    }
    else if (detected.length > 0) {
        // Only need auth for MCP tools, not for capture-only install
        token = await deviceAuth();
    }
    if (detected.length > 0 && !token) {
        console.log(`\n  ${RED}Authentication failed.${RESET} Try: npx @inariwatch/mcp init --token <your-token>\n`);
        process.exit(1);
    }
    // ── 4. Configure MCP ──
    let mcpCount = 0;
    if (detected.length > 0 && token) {
        console.log(`\n  ${DIM}Configuring MCP${RESET}\n`);
        const results = configureTools(detected, token);
        for (const r of results) {
            if (r.ok) {
                console.log(`    ${GREEN}✓${RESET} ${r.tool}`);
                mcpCount++;
            }
            else {
                console.log(`    ${RED}✗${RESET} ${r.tool} — ${r.error}`);
            }
        }
    }
    // ── 5. Link GitHub (if detected, with consent) ──
    if (github && token) {
        const consent = await ask(`  Link GitHub (${github.user}) to InariWatch? (y/N) `);
        if (consent.toLowerCase() === "y") {
            try {
                const resp = await fetch("https://app.inariwatch.com/api/cli/link", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ service: "github", token: github.token }),
                });
                if (resp.ok) {
                    console.log(`    ${GREEN}✓${RESET} GitHub linked (${github.user})`);
                }
            }
            catch {
                // Silent — non-critical
            }
        }
    }
    // ── 6. Install capture SDK ──
    let captureInstalled = false;
    if (project && !skipCapture && !project.hasCapture) {
        console.log(`\n  ${DIM}Installing @inariwatch/capture${RESET}\n`);
        const result = installCapture(project);
        if (result.ok) {
            console.log(`    ${GREEN}✓${RESET} @inariwatch/capture installed`);
            if (project.type === "nextjs") {
                console.log(`    ${GREEN}✓${RESET} next.config wrapped with withInariWatch`);
                console.log(`    ${GREEN}✓${RESET} instrumentation.ts created`);
            }
            captureInstalled = true;
        }
        else {
            console.log(`    ${RED}✗${RESET} ${result.error}`);
        }
    }
    // ── 6. Substrate prompt ──
    let substrateEnabled = false;
    if (project && !skipCapture && (captureInstalled || project.hasCapture)) {
        console.log("");
        substrateEnabled = await promptSubstrate();
        if (substrateEnabled) {
            console.log(`    ${GREEN}✓${RESET} INARIWATCH_SUBSTRATE=true added to .env`);
        }
    }
    // ── Summary ──
    const parts = [];
    if (mcpCount > 0)
        parts.push(`MCP in ${mcpCount} tool${mcpCount !== 1 ? "s" : ""}`);
    if (captureInstalled)
        parts.push("capture SDK");
    if (project?.hasCapture && !captureInstalled)
        parts.push("capture SDK (already installed)");
    if (substrateEnabled)
        parts.push("Substrate I/O");
    if (parts.length > 0) {
        console.log(`\n  ${BOLD}Done!${RESET} ${parts.join(" + ")}.\n`);
    }
    else {
        console.log(`\n  ${BOLD}Done!${RESET} Nothing to configure.\n`);
    }
    if (captureInstalled) {
        console.log(`  ${DIM}Capture runs in local mode by default (no cloud).${RESET}`);
        console.log(`  ${DIM}Set INARIWATCH_DSN in .env for cloud mode.${RESET}\n`);
    }
}
main().catch((e) => {
    console.error(`\n  ${RED}Error:${RESET} ${e.message}\n`);
    process.exit(1);
});
