/**
 * S8 — Paired-entity list.
 *
 * Renders the active paired phones (and, in S12, mobile devices) with
 * a per-row Revoke button.
 */

import { Button } from "@/components/ui";
import type { PairedEntityDto } from "@/lib/main-ipc";

export interface PairedEntityListProps {
  entities: PairedEntityDto[];
  onRevoke: (entityId: string) => void;
}

export function PairedEntityList({ entities, onRevoke }: PairedEntityListProps) {
  if (entities.length === 0) {
    return (
      <p data-testid="paired-empty" className="text-sm text-[var(--muted)]">
        No paired devices.
      </p>
    );
  }
  return (
    <ul data-testid="paired-entity-list" className="flex flex-col gap-2">
      {entities.map((e) => (
        <li
          key={e.id}
          data-testid={`paired-entity-${e.id}`}
          className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
        >
          <div className="flex flex-col">
            <span className="text-sm font-medium">{e.display_name}</span>
            <span className="text-xs text-[var(--muted)]">
              {e.redacted_identifier} · paired {formatRelative(e.paired_at_ms)}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(e.id)}
            data-testid={`paired-revoke-${e.id}`}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
