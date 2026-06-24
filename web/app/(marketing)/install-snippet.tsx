"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

type Mode = "mcp" | "cli";
type OS   = "unix" | "windows";

const CLI_COMMANDS = {
  unix: {
    label:   "macOS / Linux",
    prompt:  "$",
    comment: "# Works on macOS and Linux — installs to ~/.local/bin",
    command: "curl -fsSL https://get.inariwatch.com | sh",
  },
  windows: {
    label:   "Windows",
    prompt:  "PS>",
    comment: "# Works on Windows 10+ — installs to %USERPROFILE%\\.inariwatch\\bin",
    command: "irm https://get.inariwatch.com/install.ps1 | iex",
  },
} as const;

export function InstallSnippet() {
  const [mode, setMode] = useState<Mode>("mcp");
  const [os,   setOs]   = useState<OS>("unix");

  return (
    <div
      className="w-full rounded-xl overflow-hidden font-mono text-sm select-none"
      style={{
        background: "#0e0e11",
        border: "1px solid rgba(255,255,255,0.07)",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.03), 0 16px 48px rgba(0,0,0,0.4)",
      }}
    >
      {/* Chrome bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}
      >
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]/70" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]/70" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]/70" />
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: "rgba(255,255,255,0.05)" }}>
          {(["mcp", "cli"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                mode === m
                  ? "bg-inari-accent text-black shadow-sm"
                  : "text-white/35 hover:text-white/65"
              }`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Code area */}
      <div className="px-5 py-4 space-y-2">
        {mode === "mcp" ? (
          <>
            <p className="text-white/25 text-xs">
              # Connect any AI tool — Claude, Cursor, Windsurf, Codex, Gemini, OpenClaw
            </p>
            <div className="flex items-center gap-3">
              <span className="text-inari-accent select-none">$</span>
              <span className="flex-1 text-white/75">npx @inariwatch/mcp init</span>
              <CopyButton text="npx @inariwatch/mcp init" />
            </div>
          </>
        ) : (
          <>
            {/* OS tabs */}
            <div className="flex items-center gap-1 mb-1">
              {(["unix", "windows"] as OS[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setOs(key)}
                  className={`px-2 py-0.5 rounded text-[11px] transition-all ${
                    os === key
                      ? "bg-white/10 text-white/65"
                      : "text-white/25 hover:text-white/45"
                  }`}
                >
                  {CLI_COMMANDS[key].label}
                </button>
              ))}
            </div>
            <p className="text-white/25 text-xs">{CLI_COMMANDS[os].comment}</p>
            <div className="flex items-center gap-3">
              <span className="text-inari-accent select-none">{CLI_COMMANDS[os].prompt}</span>
              <span className="flex-1 text-white/75">{CLI_COMMANDS[os].command}</span>
              <CopyButton text={CLI_COMMANDS[os].command} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
