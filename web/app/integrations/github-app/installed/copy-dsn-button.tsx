"use client";

import { useState } from "react";

/**
 * Tiny client island for the "Copy DSN" button. Lives next to the page
 * because it's the only piece of interactivity on the otherwise-static
 * server-rendered confirmation.
 */
export function CopyDsnButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`INARIWATCH_DSN=${value}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Best-effort — the user can still highlight + Cmd-C the line.
        }
      }}
      className="rounded-lg border border-inari-border bg-inari-surface-3 px-3 py-1.5 text-xs font-medium hover:opacity-90"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
