"use client";

import { formatRelativeTime } from "@/lib/utils";

interface AuditEntry {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  createdAt: Date;
}

export function AuditLogSection({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="py-4 text-center">
        <p className="text-sm text-fg-base/60">No audit log entries yet.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-line-subtle max-h-[300px] overflow-y-auto">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-3 py-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-fg-base">
              <span className="font-mono text-xs text-fg-base/60">{entry.action}</span>
              <span className="mx-1.5 text-fg-base/40">&middot;</span>
              <span className="text-xs text-fg-base/60">{entry.resource}</span>
            </p>
          </div>
          <span className="text-xs font-mono text-fg-base/50 shrink-0">
            {formatRelativeTime(entry.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
