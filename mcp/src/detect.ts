import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type Tool = {
  name: string;
  id: string;
  detected: boolean;
  version?: string;
};

function which(cmd: string): string | null {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(command, [cmd], { encoding: "utf8", stdio: "pipe" });
    return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
  } catch {
    return null;
  }
}

function getVersion(cmd: string): string | null {
  try {
    let r = spawnSync(cmd, ["--version"], { encoding: "utf8", stdio: "pipe" });
    if (r.status !== 0) {
      r = spawnSync(cmd, ["-v"], { encoding: "utf8", stdio: "pipe" });
      if (r.status !== 0) return null;
    }
    const match = r.stdout.trim().match(/\d+\.\d+[\.\d]*/);
    return match ? match[0] : r.stdout.trim().slice(0, 30);
  } catch {
    return null;
  }
}

export function detectTools(): Tool[] {
  const home = homedir();
  const isWin = process.platform === "win32";
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");

  return [
    {
      name: "Claude Code",
      id: "claude",
      detected: !!which("claude"),
      version: getVersion("claude") ?? undefined,
    },
    {
      name: "Cursor",
      id: "cursor",
      detected: existsSync(isWin ? join(appData, "Cursor") : join(home, ".cursor")),
    },
    {
      name: "Windsurf",
      id: "windsurf",
      detected: existsSync(isWin ? join(appData, "Windsurf") : join(home, ".windsurf")),
    },
    {
      name: "VS Code + Copilot",
      id: "vscode",
      detected: !!which("code"),
      version: getVersion("code") ?? undefined,
    },
    {
      name: "Codex CLI",
      id: "codex",
      detected: !!which("codex"),
      version: getVersion("codex") ?? undefined,
    },
    {
      name: "Gemini CLI",
      id: "gemini",
      detected: !!which("gemini"),
      version: getVersion("gemini") ?? undefined,
    },
  ];
}

export type GitHubAuth = { token: string; user: string };

/**
 * Detect if `gh` CLI is installed and authenticated.
 * Returns token + username, or null if not available.
 * Never throws — silent skip if gh is missing or not logged in.
 */
export function detectGitHub(): GitHubAuth | null {
  if (!which("gh")) return null;
  try {
    const status = spawnSync("gh", ["auth", "status"], { encoding: "utf8", stdio: "pipe" });
    const statusOut = (status.stdout || "") + (status.stderr || "");
    if (!statusOut.includes("Logged in")) return null;

    const tokenResult = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: "pipe" });
    const token = tokenResult.stdout?.trim();
    if (!token) return null;

    const userResult = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: "pipe" });
    const user = userResult.stdout?.trim();

    return { token, user: user || "unknown" };
  } catch {
    return null;
  }
}
