"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureTools = configureTools;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const MCP_URL = "https://mcp.inariwatch.com";
function configureTools(tools, token) {
    const results = [];
    for (const tool of tools) {
        if (!tool.detected)
            continue;
        try {
            switch (tool.id) {
                case "claude":
                    configureClaude(token);
                    break;
                case "cursor":
                    writeJsonConfig(cursorConfigPath(), token);
                    break;
                case "windsurf":
                    writeJsonConfig(windsurfConfigPath(), token);
                    break;
                case "vscode":
                    writeJsonConfig(vscodeConfigPath(), token);
                    break;
                case "codex":
                    configureCodex(token);
                    break;
                case "gemini":
                    configureGemini(token);
                    break;
                default:
                    continue;
            }
            results.push({ tool: tool.name, ok: true });
        }
        catch (e) {
            results.push({
                tool: tool.name,
                ok: false,
                error: e instanceof Error ? e.message : "Unknown error",
            });
        }
    }
    return results;
}
function configureClaude(token) {
    const result = (0, child_process_1.spawnSync)("claude", [
        "mcp", "add", "inariwatch", MCP_URL,
        "--transport", "http",
        "-H", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "claude mcp add failed");
}
function configureCodex(token) {
    const result = (0, child_process_1.spawnSync)("codex", [
        "mcp", "add", "inariwatch", MCP_URL,
        "--header", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "codex mcp add failed");
}
function configureGemini(token) {
    const result = (0, child_process_1.spawnSync)("gemini", [
        "mcp", "add", "inariwatch",
        "--url", MCP_URL,
        "--header", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "gemini mcp add failed");
}
function cursorConfigPath() {
    const home = (0, os_1.homedir)();
    return process.platform === "win32"
        ? (0, path_1.join)(process.env.APPDATA || (0, path_1.join)(home, "AppData", "Roaming"), "Cursor", "mcp.json")
        : (0, path_1.join)(home, ".cursor", "mcp.json");
}
function windsurfConfigPath() {
    const home = (0, os_1.homedir)();
    return process.platform === "win32"
        ? (0, path_1.join)(process.env.APPDATA || (0, path_1.join)(home, "AppData", "Roaming"), "Windsurf", "mcp.json")
        : (0, path_1.join)(home, ".windsurf", "mcp.json");
}
function vscodeConfigPath() {
    // Write to workspace .vscode/mcp.json if in a project, otherwise user-level
    const workspaceConfig = (0, path_1.join)(process.cwd(), ".vscode", "mcp.json");
    if ((0, fs_1.existsSync)((0, path_1.join)(process.cwd(), ".vscode")))
        return workspaceConfig;
    const home = (0, os_1.homedir)();
    return process.platform === "win32"
        ? (0, path_1.join)(process.env.APPDATA || (0, path_1.join)(home, "AppData", "Roaming"), "Code", "User", "mcp.json")
        : (0, path_1.join)(home, ".config", "Code", "User", "mcp.json");
}
function writeJsonConfig(configPath, token) {
    const dir = (0, path_1.dirname)(configPath);
    if (!(0, fs_1.existsSync)(dir))
        (0, fs_1.mkdirSync)(dir, { recursive: true });
    // Determine config shape (VS Code uses "servers", Cursor/Windsurf use "mcpServers")
    const isVscode = configPath.includes("Code") || configPath.includes(".vscode");
    const serverKey = isVscode ? "servers" : "mcpServers";
    const inariConfig = {
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
    };
    let existing = {};
    if ((0, fs_1.existsSync)(configPath)) {
        try {
            existing = JSON.parse((0, fs_1.readFileSync)(configPath, "utf8"));
        }
        catch {
            // Corrupt JSON — overwrite
        }
    }
    const servers = existing[serverKey] ?? {};
    servers["inariwatch"] = inariConfig;
    existing[serverKey] = servers;
    (0, fs_1.writeFileSync)(configPath, JSON.stringify(existing, null, 2) + "\n");
}
