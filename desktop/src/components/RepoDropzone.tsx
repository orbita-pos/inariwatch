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
    <div className="flex flex-col items-center gap-3 w-full">
      <motion.div
        data-testid="repo-dropzone"
        data-hover={hover ? "true" : "false"}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          // S33: bigger surface (max-w-lg, aspect ratio 5:3 → roomier),
          // dashed border ramps to burnt orange on hover/drag, transition
          // is colors-only (no scale).
          "relative w-full max-w-lg aspect-[5/3] rounded-[var(--radius-lg)]",
          "border-2 border-dashed flex flex-col items-center justify-center gap-4",
          "px-8 py-10 text-center cursor-pointer",
          "transition-colors duration-[var(--duration-medium)] ease-[var(--easing-out)]",
          hover
            ? "border-[var(--accent)] bg-[rgb(234_88_12_/_0.05)]"
            : "border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--accent-light)]",
          disabled && "opacity-60 pointer-events-none",
        )}
        // Subtle "respire" pulse — opacity only, never scale (Linear anti-pattern).
        animate={
          reduce || hover
            ? { opacity: 1 }
            : { opacity: [1, 0.94, 1] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 4, ease: "easeInOut", repeat: Infinity }
        }
        onClick={() => !disabled && onBrowse()}
      >
        <p className="font-[var(--font-serif)] text-[24px] leading-tight text-[var(--text)]">
          Drop your repository here
        </p>
        <p className="text-[13px] text-[var(--text-muted)] max-w-[40ch] leading-relaxed">
          Inari watches code locally — nothing leaves your machine. You can
          connect more repos from Settings later.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={(e) => {
            // Stop the parent <motion.div onClick> from re-firing onBrowse.
            e.stopPropagation();
            onBrowse();
          }}
          disabled={disabled}
          data-testid="repo-dropzone-browse"
        >
          Browse…
        </Button>
      </motion.div>
      {hint ? (
        <p
          className="text-[12px] text-[var(--text-muted)]"
          role="note"
          data-testid="repo-dropzone-hint"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
