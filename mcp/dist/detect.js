"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectTools = detectTools;
exports.detectGitHub = detectGitHub;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
function which(cmd) {
    try {
        return (0, child_process_1.execSync)(`which ${cmd} 2>/dev/null || where ${cmd} 2>NUL`, {
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
        const out = (0, child_process_1.execSync)(`${cmd} --version 2>/dev/null || ${cmd} -v 2>NUL`, {
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
function detectTools() {
    const home = (0, os_1.homedir)();
    const isWin = process.platform === "win32";
    const appData = process.env.APPDATA || (0, path_1.join)(home, "AppData", "Roaming");
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
            detected: (0, fs_1.existsSync)(isWin ? (0, path_1.join)(appData, "Cursor") : (0, path_1.join)(home, ".cursor")),
        },
        {
            name: "Windsurf",
            id: "windsurf",
            detected: (0, fs_1.existsSync)(isWin ? (0, path_1.join)(appData, "Windsurf") : (0, path_1.join)(home, ".windsurf")),
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
function detectGitHub() {
    if (!which("gh"))
        return null;
    try {
        const status = (0, child_process_1.execSync)("gh auth status 2>&1", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        });
        if (!status.includes("Logged in"))
            return null;
        const token = (0, child_process_1.execSync)("gh auth token", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (!token)
            return null;
        const user = (0, child_process_1.execSync)("gh api user --jq .login 2>/dev/null", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { token, user: user || "unknown" };
    }
    catch {
        return null;
    }
}
