import { motion, useReducedMotion } from "framer-motion";
import { useState, type DragEvent } from "react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/cn";

interface RepoDropzoneProps {
  onAccept: (path: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  /** Optional inline error/warning text rendered under the zone. */
  hint?: string;
}

/**
 * Linear-style respiring dropzone. Accepts a folder drop and falls back
 * to a click-to-browse button. Validation hint is owned by the parent —
 * we just surface dragover state here.
 */
export function RepoDropzone({ onAccept, onBrowse, disabled, hint }: RepoDropzoneProps) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState(false);

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!disabled) setHover(true);
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setHover(false);
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setHover(false);
    if (disabled) return;
    // Tauri attaches a custom `__dirPath` field to `DataTransfer.items`
    // when the user drops a folder; we accept either. As a fallback the
    // browse button always works.
    const items = e.dataTransfer?.items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      // Tauri-specific path attribute may exist on the underlying entry.
      const file = item?.getAsFile?.();
      const candidate =
        // @ts-expect-error Tauri-specific path attribute
        item?.path ?? file?.path ?? file?.name;
      if (typeof candidate === "string" && candidate.length > 0) {
        onAccept(candidate);
        return;
      }
    }
    // jsdom-friendly fallback: read e.dataTransfer.getData("text/plain").
    const fallback = e.dataTransfer?.getData?.("text/plain");
    if (typeof fallback === "string" && fallback.length > 0) {
      onAccept(fallback);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <motion.div
        data-testid="repo-dropzone"
        data-hover={hover ? "true" : "false"}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          "relative w-full max-w-md aspect-[3/2] rounded-[var(--radius-2xl)]",
          "border-2 border-dashed flex flex-col items-center justify-center gap-3",
          "px-6 py-8 text-center",
          hover
            ? "border-[var(--accent)] bg-[var(--accent)]/5"
            : "border-[var(--border)] bg-[var(--surface)]",
          disabled && "opacity-60 pointer-events-none",
        )}
        animate={
          reduce || hover
            ? { scale: 1 }
            : { scale: [1, 1.02, 1] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 4, ease: "easeInOut", repeat: Infinity }
        }
      >
        <p className="font-[var(--font-serif)] text-lg leading-tight">
          Drop your repository here
        </p>
        <p className="text-sm text-[var(--muted)] max-w-[34ch]">
          Inari will start watching it. You can connect more later.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={onBrowse}
          disabled={disabled}
          data-testid="repo-dropzone-browse"
        >
          Browse…
        </Button>
      </motion.div>
      {hint ? (
        <p className="text-xs text-[var(--muted)]" role="note">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
