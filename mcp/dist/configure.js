import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
const MCP_URL = "https://mcp.inariwatch.com";
export function configureTools(tools, token) {
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
    const result = spawnSync("claude", [
        "mcp", "add", "inariwatch", MCP_URL,
        "--transport", "http",
        "-H", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "claude mcp add failed");
}
function configureCodex(token) {
    const result = spawnSync("codex", [
        "mcp", "add", "inariwatch", MCP_URL,
        "--header", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "codex mcp add failed");
}
function configureGemini(token) {
    const result = spawnSync("gemini", [
        "mcp", "add", "inariwatch",
        "--url", MCP_URL,
        "--header", `Authorization: Bearer ${token}`,
    ], { stdio: "pipe" });
    if (result.status !== 0)
        throw new Error(result.stderr?.toString().trim() || "gemini mcp add failed");
}
function cursorConfigPath() {
    const home = homedir();
    return process.platform === "win32"
        ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "mcp.json")
        : join(home, ".cursor", "mcp.json");
}
function windsurfConfigPath() {
    const home = homedir();
    return process.platform === "win32"
        ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Windsurf", "mcp.json")
        : join(home, ".windsurf", "mcp.json");
}
function vscodeConfigPath() {
    // Write to workspace .vscode/mcp.json if in a project, otherwise user-level
    const workspaceConfig = join(process.cwd(), ".vscode", "mcp.json");
    if (existsSync(join(process.cwd(), ".vscode")))
        return workspaceConfig;
    const home = homedir();
    return process.platform === "win32"
        ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User", "mcp.json")
        : join(home, ".config", "Code", "User", "mcp.json");
}
function writeJsonConfig(configPath, token) {
    const dir = dirname(configPath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    // Determine config shape (VS Code uses "servers", Cursor/Windsurf use "mcpServers")
    const isVscode = configPath.includes("Code") || configPath.includes(".vscode");
    const serverKey = isVscode ? "servers" : "mcpServers";
    const inariConfig = {
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
    };
    let existing = {};
    if (existsSync(configPath)) {
        try {
            existing = JSON.parse(readFileSync(configPath, "utf8"));
        }
        catch {
            // Corrupt JSON — overwrite
        }
    }
    const servers = existing[serverKey] ?? {};
    servers["inariwatch"] = inariConfig;
    existing[serverKey] = servers;
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}
