import { Command } from "cmdk";
import { Search, MessageSquare, FileSearch, Wrench, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";

interface CommandPaletteProps {
  /** Optional controlled state for tests + parent-controlled flows. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Search;
  /** Stub commands — Session 15 wires these into Zustand actions + IPC. */
  action: () => void;
}

const STUBS: PaletteCommand[] = [
  {
    id: "chat",
    label: "Chat with Inari",
    hint: "Ask anything about this repo",
    icon: MessageSquare,
    action: () => console.info("[palette] chat — Session 15 wires this"),
  },
  {
    id: "search",
    label: "Search code",
    hint: "Semantic search across the indexed repo",
    icon: FileSearch,
    action: () => console.info("[palette] search — Session 15 wires this"),
  },
  {
    id: "fix",
    label: "Fix latest error",
    hint: "Run a remediation pass on the last alert",
    icon: Wrench,
    action: () => console.info("[palette] fix — Session 19 wires this"),
  },
  {
    id: "settings",
    label: "Open Settings",
    hint: "Theme, sensors, AI, account",
    icon: SettingsIcon,
    action: () => console.info("[palette] settings — Session 17 wires this"),
  },
];

/**
 * cmdk-based command palette. Cmd/Ctrl+K toggles it. The commands listed
 * here are intentionally stubs in Session 14 — the wiring lands in
 * Session 15 (chat/search), Session 19 (fix), Session 17 (settings).
 *
 * Tests open/close the palette by manipulating the `open` prop, but the
 * default uncontrolled flow lives behind the keyboard shortcut so manual
 * smoke testing requires no instrumentation.
 */
export function CommandPalette({ open: controlledOpen, onOpenChange }: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    if (controlledOpen === undefined) setInternalOpen(next);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const trigger = e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey);
      if (trigger) {
        e.preventDefault();
        setOpen(!open);
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Inari command palette"
      className={cn(
        "fixed left-1/2 top-[20%] -translate-x-1/2 w-[min(92vw,560px)]",
        "rounded-[var(--radius-xl)] border border-[var(--border)]",
        "bg-[var(--bg)] shadow-[var(--shadow-3)] overflow-hidden",
        "z-[200]",
      )}
    >
      <div className="flex items-center gap-2 px-3 border-b border-[var(--border)]">
        <Search className="h-4 w-4 text-[var(--muted)]" aria-hidden />
        <Command.Input
          placeholder="Ask Inari, search, or run a command…"
          className={cn(
            "flex-1 h-11 bg-transparent text-sm text-[var(--text)]",
            "placeholder:text-[var(--muted)] outline-none",
          )}
        />
      </div>
      <Command.List className="max-h-[320px] overflow-auto p-2">
        <Command.Empty className="text-sm text-[var(--muted)] p-3">
          No matches.
        </Command.Empty>
        <Command.Group heading="Quick actions">
          {STUBS.map((c) => {
            const Icon = c.icon;
            return (
              <Command.Item
                key={c.id}
                value={`${c.label} ${c.hint ?? ""}`}
                onSelect={() => {
                  c.action();
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-[var(--radius-sm)]",
                  "cursor-pointer select-none text-sm text-[var(--text)]",
                  "data-[selected=true]:bg-[var(--surface)]",
                )}
              >
                <Icon className="h-4 w-4 text-[var(--muted)]" aria-hidden />
                <span className="flex-1">{c.label}</span>
                {c.hint ? (
                  <span className="text-xs text-[var(--muted)]">{c.hint}</span>
                ) : null}
              </Command.Item>
            );
          })}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
