"use client";

import { useState } from "react";
import { CopyButton } from "./copy-button";

const COMMANDS = {
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

type OS = keyof typeof COMMANDS;

export function InstallSnippet() {
  const [os, setOs] = useState<OS>("unix");
  const { prompt, comment, command } = COMMANDS[os];

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
        {/* OS tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5">
          {(Object.keys(COMMANDS) as OS[]).map((key) => (
            <button
              key={key}
              onClick={() => setOs(key)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                os === key
                  ? "bg-inari-accent text-black shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {COMMANDS[key].label}
            </button>
          ))}
        </div>
      </div>

      {/* Code area */}
      <div className="px-5 py-4 space-y-2">
        <p className="text-zinc-500">{comment}</p>
        <div className="flex items-center gap-3">
          <span className="text-inari-accent select-none">{prompt}</span>
          <span className="flex-1 text-zinc-200">{command}</span>
          <CopyButton text={command} />
        </div>
      </div>
    </div>
  );
}
