import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
function which(cmd) {
    try {
        return execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>NUL`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n")[0] || null;
    }
    catch {
        return null;
    }
}
function getVersion(cmd) {
    try {
        const out = execSync(`${cmd} --version 2>/dev/null || ${cmd} -v 2>NUL`, {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        // Extract version number
        const match = out.match(/\d+\.\d+[\.\d]*/);
        return match ? match[0] : out.slice(0, 30);
    }
    catch {
        return null;
    }
}
export function detectTools() {
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
/**
 * Detect if `gh` CLI is installed and authenticated.
 * Returns token + username, or null if not available.
 * Never throws — silent skip if gh is missing or not logged in.
 */
export function detectGitHub() {
    if (!which("gh"))
        return null;
    try {
        const status = execSync("gh auth status 2>&1", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (!status.includes("Logged in"))
            return null;
        const token = execSync("gh auth token", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (!token)
            return null;
        const user = execSync("gh api user --jq .login 2>/dev/null", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { token, user: user || "unknown" };
    }
    catch {
        return null;
    }
}
