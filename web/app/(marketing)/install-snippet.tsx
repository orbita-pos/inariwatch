"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

type Mode = "cli" | "mcp";

const CLI_COMMANDS = {
  unix: {
    label: "macOS / Linux",
    prompt: "$",
    comment: "# Works on macOS and Linux. Installs to ~/.local/bin",
    command: "curl -fsSL https://get.inariwatch.com | sh",
  },
  windows: {
    label: "Windows",
    prompt: "PS>",
    comment: "# Works on Windows 10+. Installs to %USERPROFILE%\\.inariwatch\\bin",
    command: "irm https://get.inariwatch.com/install.ps1 | iex",
  },
} as const;

type OS = keyof typeof CLI_COMMANDS;

export function InstallSnippet() {
  const [mode, setMode] = useState<Mode>("mcp");
  const [os, setOs] = useState<OS>("unix");

  return (
    <div className="w-full rounded-xl border border-white/10 bg-black/60 backdrop-blur-sm overflow-hidden font-mono text-sm">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 bg-white/[0.03]">
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-red-500/70" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <span className="w-3 h-3 rounded-full bg-green-500/70" />
        </div>
        {/* Mode tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5">
          <button
            onClick={() => setMode("mcp")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              mode === "mcp"
                ? "bg-inari-accent text-black shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            MCP
          </button>
          <button
            onClick={() => setMode("cli")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              mode === "cli"
                ? "bg-inari-accent text-black shadow-sm"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            CLI
          </button>
        </div>
      </div>

      {/* Code area */}
      {mode === "mcp" ? (
        <div className="px-5 py-4 space-y-2">
          <p className="text-zinc-500"># Connect any AI tool — Claude, Cursor, Windsurf, Codex, Gemini</p>
          <div className="flex items-center gap-3">
            <span className="text-inari-accent select-none">$</span>
            <span className="flex-1 text-zinc-200">npx @inariwatch/mcp init</span>
            <CopyButton text="npx @inariwatch/mcp init" />
          </div>
        </div>
      ) : (
        <div className="px-5 py-4 space-y-2">
          {/* OS switcher for CLI */}
          <div className="flex items-center gap-2 mb-2">
            {(Object.keys(CLI_COMMANDS) as OS[]).map((key) => (
              <button
                key={key}
                onClick={() => setOs(key)}
                className={`px-2 py-0.5 rounded text-[11px] transition-all ${
                  os === key
                    ? "bg-white/10 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {CLI_COMMANDS[key].label}
              </button>
            ))}
          </div>
          <p className="text-zinc-500">{CLI_COMMANDS[os].comment}</p>
          <div className="flex items-center gap-3">
            <span className="text-inari-accent select-none">{CLI_COMMANDS[os].prompt}</span>
            <span className="flex-1 text-zinc-200">{CLI_COMMANDS[os].command}</span>
            <CopyButton text={CLI_COMMANDS[os].command} />
          </div>
        </div>
      )}
    </div>
  );
}
