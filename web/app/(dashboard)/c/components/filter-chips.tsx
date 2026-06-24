"use client";

import { cn } from "@/lib/utils";

export type SidebarFilter = "all" | "critical" | "mine" | "snoozed";

interface FilterChipsProps {
  value: SidebarFilter;
  onChange: (next: SidebarFilter) => void;
}

interface ChipDef {
  id: SidebarFilter;
  label: string;
  glyph?: string;
}

const CHIPS: ReadonlyArray<ChipDef> = [
  { id: "all",      label: "All" },
  { id: "critical", label: "Critical", glyph: "🔴" },
  { id: "mine",     label: "Mine" },
  { id: "snoozed",  label: "Snoozed",  glyph: "💤" },
];

/**
 * Single-select inbox filter chips. Ghost-variant — same visual posture
 * as the host-detection chips in S4's manual-setup screen so the design
 * system stays coherent.
 */
export function FilterChips({ value, onChange }: FilterChipsProps) {
  return (
    <div role="radiogroup" aria-label="Inbox filter" className="flex flex-wrap gap-1.5">
      {CHIPS.map((chip) => {
        const selected = value === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(chip.id)}
            data-testid={`inbox-filter-${chip.id}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              selected
                ? "border-inari-accent bg-inari-accent/10 text-inari-accent"
                : "border-line bg-surface-dim text-fg-base/70 hover:text-fg-strong hover:border-line-medium",
            )}
          >
            {chip.glyph ? <span aria-hidden>{chip.glyph}</span> : null}
            <span>{chip.label}</span>
          </button>
        );
      })}
    </div>
  );
}
