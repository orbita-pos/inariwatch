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
        <p className="text-sm text-zinc-500">No audit log entries yet.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[#131313] max-h-[300px] overflow-y-auto">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-3 py-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-zinc-300">
              <span className="font-mono text-xs text-zinc-500">{entry.action}</span>
              <span className="mx-1.5 text-zinc-700">&middot;</span>
              <span className="text-xs text-zinc-500">{entry.resource}</span>
            </p>
          </div>
          <span className="text-xs font-mono text-zinc-600 shrink-0">
            {formatRelativeTime(entry.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
