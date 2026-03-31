#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const detect_js_1 = require("./detect.js");
const configure_js_1 = require("./configure.js");
const auth_js_1 = require("./auth.js");
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    if (command !== "init" && command !== undefined) {
        console.log(`\n  ${BOLD}@inariwatch/mcp${RESET}\n`);
        console.log(`  Usage: npx @inariwatch/mcp init [--token <token>]\n`);
        console.log(`  Options:`);
        console.log(`    init              Detect AI tools and configure MCP`);
        console.log(`    init --token <t>  Use a specific token instead of browser auth\n`);
        process.exit(0);
    }
    console.log(`\n  ${BOLD}InariWatch MCP Setup${RESET}\n`);
    // 1. Detect tools
    console.log("  Detecting AI tools...\n");
    const tools = (0, detect_js_1.detectTools)();
    const detected = tools.filter((t) => t.detected);
    const notFound = tools.filter((t) => !t.detected);
    for (const t of detected) {
        const ver = t.version ? ` ${DIM}(${t.version})${RESET}` : "";
        console.log(`    ${GREEN}✓${RESET} ${t.name}${ver}`);
    }
    for (const t of notFound) {
        console.log(`    ${DIM}✗ ${t.name} (not found)${RESET}`);
    }
    if (detected.length === 0) {
        console.log(`\n  ${RED}No AI tools detected.${RESET} Install Claude Code, Cursor, or another supported tool first.\n`);
        process.exit(1);
    }
    // 2. Get token
    const tokenFlag = args.indexOf("--token");
    let token = null;
    if (tokenFlag !== -1 && args[tokenFlag + 1]) {
        token = args[tokenFlag + 1];
        if (!token.startsWith("inari_")) {
            console.log(`\n  ${RED}Invalid token.${RESET} Tokens start with "inari_". Get one at app.inariwatch.com/settings\n`);
            process.exit(1);
        }
        console.log(`\n  ${GREEN}✓${RESET} Using provided token`);
    }
    else {
        token = await (0, auth_js_1.deviceAuth)();
    }
    if (!token) {
        console.log(`\n  ${RED}Authentication failed.${RESET} Try: npx @inariwatch/mcp init --token <your-token>\n`);
        process.exit(1);
    }
    // 3. Configure
    console.log("\n  Configuring...\n");
    const results = (0, configure_js_1.configureTools)(detected, token);
    let successCount = 0;
    for (const r of results) {
        if (r.ok) {
            console.log(`    ${GREEN}✓${RESET} ${r.tool}`);
            successCount++;
        }
        else {
            console.log(`    ${RED}✗${RESET} ${r.tool} — ${r.error}`);
        }
    }
    console.log(`\n  ${BOLD}Done!${RESET} InariWatch MCP is ready in ${successCount} tool${successCount !== 1 ? "s" : ""}.\n`);
}
main().catch((e) => {
    console.error(`\n  ${RED}Error:${RESET} ${e.message}\n`);
    process.exit(1);
});
