import { type MouseEvent } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/cn";
import { witnessChipLabel } from "@/lib/audit-ui-ipc";

/**
 * Witness chip — `[verified:abc12345]` or `[no-receipt]`. Click flips
 * the parent's verifier modal open. The chip itself does NOT call
 * verify — that's the modal's job, which lets the caller open the
 * modal cold and run the check the user is watching.
 *
 * Visual model: filled neutral pill for verified rows, dashed muted
 * pill for rows with no receipt (a less-confident state). Both use
 * `--accent` only on focus / hover so the chip recedes inside a dense
 * audit table.
 */
export interface WitnessChipProps {
  receiptId: string | null;
  onOpen: (receiptId: string | null) => void;
  /** Optional `data-testid` so audit-row tests can target one chip. */
  testId?: string;
}

export function WitnessChip({ receiptId, onOpen, testId }: WitnessChipProps) {
  const label = witnessChipLabel(receiptId);
  const verified = receiptId !== null;
  const Icon = verified ? ShieldCheck : ShieldAlert;

  function onClick(e: MouseEvent<HTMLButtonElement>) {
    // Stop the event from bubbling up to the table row's click handler
    // (which expands the row). Otherwise opening the modal also opens
    // the row, which is busy + jarring.
    e.stopPropagation();
    onOpen(receiptId);
  }

  return (
    <button
      type="button"
      data-testid={testId ?? "witness-chip"}
      data-verified={verified ? "true" : "false"}
      onClick={onClick}
      title={
        verified
          ? "Verify hash integrity vs the witness receipt"
          : "Row has no witness receipt — likely pre-agent"
      }
      className={cn(
        "inline-flex items-center gap-1 h-5 px-1.5",
        "rounded-[var(--radius-sm)] text-[11px] font-mono",
        "transition-colors duration-[var(--duration-fast)] cursor-pointer",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        verified
          ? "bg-[var(--card-elevated)] text-[var(--text)] border border-[var(--border)] hover:border-[var(--border-strong)]"
          : "bg-transparent text-[var(--text-subtle)] border border-dashed border-[var(--border)] hover:text-[var(--text-muted)]",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}
