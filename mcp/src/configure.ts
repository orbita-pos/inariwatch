import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { Tool } from "./detect.js";

const MCP_URL = "https://mcp.inariwatch.com";

type ConfigResult = { tool: string; ok: boolean; error?: string };

export function configureTools(tools: Tool[], token: string): ConfigResult[] {
  const results: ConfigResult[] = [];

  for (const tool of tools) {
    if (!tool.detected) continue;

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
        case "openclaw":
          configureOpenClaw(token);
          break;
        default:
          continue;
      }
      results.push({ tool: tool.name, ok: true });
    } catch (e) {
      results.push({
        tool: tool.name,
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  return results;
}

function configureClaude(token: string): void {
  // Remove existing server first (ignore errors — may not exist)
  spawnSync("claude", ["mcp", "remove", "inariwatch"], { stdio: "pipe" });

  const result = spawnSync("claude", [
    "mcp", "add", "--transport", "http",
    "inariwatch", MCP_URL,
    "-H", `Authorization: Bearer ${token}`,
  ], { stdio: "pipe" });

  if (result.status !== 0) {
    const err = result.stderr?.toString().trim() || result.stdout?.toString().trim() || "claude mcp add failed";
    throw new Error(err);
  }
}

function configureCodex(token: string): void {
  const result = spawnSync("codex", [
    "mcp", "add", "inariwatch", MCP_URL,
    "--header", `Authorization: Bearer ${token}`,
  ], { stdio: "pipe" });
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || "codex mcp add failed");
}

function configureGemini(token: string): void {
  const result = spawnSync("gemini", [
    "mcp", "add", "inariwatch",
    "--url", MCP_URL,
    "--header", `Authorization: Bearer ${token}`,
  ], { stdio: "pipe" });
  if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || "gemini mcp add failed");
}

function configureOpenClaw(token: string): void {
  // Try CLI first (if openclaw binary is in PATH)
  const cliResult = spawnSync("openclaw", [
    "mcp", "set", "inariwatch",
    JSON.stringify({
      url: MCP_URL,
      transport: "streamable-http",
      headers: { Authorization: `Bearer ${token}` },
    }),
  ], { stdio: "pipe" });

  if (cliResult.status === 0) return;

  // Fallback: write directly to ~/.openclaw/openclaw.json
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      // Corrupt JSON — overwrite
    }
  }

  const mcp = (existing.mcp as Record<string, unknown>) ?? {};
  const servers = (mcp.servers as Record<string, unknown>) ?? {};
  servers["inariwatch"] = {
    url: MCP_URL,
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${token}` },
  };
  mcp.servers = servers;
  existing.mcp = mcp;

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}

function cursorConfigPath(): string {
  const home = homedir();
  return process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "mcp.json")
    : join(home, ".cursor", "mcp.json");
}

function windsurfConfigPath(): string {
  const home = homedir();
  return process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Windsurf", "mcp.json")
    : join(home, ".windsurf", "mcp.json");
}

function vscodeConfigPath(): string {
  // Write to workspace .vscode/mcp.json if in a project, otherwise user-level
  const workspaceConfig = join(process.cwd(), ".vscode", "mcp.json");
  if (existsSync(join(process.cwd(), ".vscode"))) return workspaceConfig;

  const home = homedir();
  return process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User", "mcp.json")
    : join(home, ".config", "Code", "User", "mcp.json");
}

function writeJsonConfig(configPath: string, token: string): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Determine config shape (VS Code uses "servers", Cursor/Windsurf use "mcpServers")
  const isVscode = configPath.includes("Code") || configPath.includes(".vscode");
  const serverKey = isVscode ? "servers" : "mcpServers";

  const inariConfig = {
    url: MCP_URL,
    headers: { Authorization: `Bearer ${token}` },
  };

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      // Corrupt JSON — overwrite
    }
  }

  const servers = (existing[serverKey] as Record<string, unknown>) ?? {};
  servers["inariwatch"] = inariConfig;
  existing[serverKey] = servers;

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}
