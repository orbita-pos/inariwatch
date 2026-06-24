"use client";

import { useState } from "react";
import { Copy, Check, X } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  const copy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setState("copied");
    } catch {
      setState("error");
    } finally {
      setTimeout(() => setState("idle"), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="text-white/25 hover:text-white/60 transition-colors"
      aria-label={
        state === "copied" ? "Copied to clipboard"
        : state === "error" ? "Copy failed — select manually"
        : "Copy install command"
      }
    >
      {state === "copied" ? (
        <Check className="h-4 w-4 text-green-400" aria-hidden="true" />
      ) : state === "error" ? (
        <X className="h-4 w-4 text-red-400" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
