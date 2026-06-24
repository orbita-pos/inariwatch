/**
 * Phase 5.7 — alert picker (with scoped-memory promotion).
 *
 * The picker:
 *   1. Reads `scopedMemory.recent()` to find alerts the user just
 *      saw (e.g. after `/alerts`). Those promote to the top of the
 *      list, marked "recent".
 *   2. Falls back to `listAlerts(20)` for fresh data.
 *   3. Deduplicates by id; the "recent" set wins.
 *
 * Search is case-insensitive substring against title, severity,
 * project, OR hash. Picking dispatches `{kind: "alert", id, hash,
 * title}`; the dispatcher's `mergeSlotValue` lifts the hash into the
 * `_hash` companion + `_display` for the picker header.
 */
import { Clock, Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  listAlerts,
  type AlertEntity,
} from "@/lib/slash/entities/alerts";
import type {
  MemoryEntry,
  ResolvedEntity,
  ScopedMemory,
} from "@/lib/slash/scoped-memory";
import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";

export interface AlertPickerSlotProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  /**
   * Phase 5.7 — read scoped memory for promotion. When unset (test
   * harness), the picker falls back to the cloud list only.
   */
  scopedMemory?: ScopedMemory;
  /** Test injection — replaces `listAlerts()`. */
  list?: typeof listAlerts;
}

interface PickerRow {
  entity: AlertEntity;
  /** True if surfaced from scoped memory (renders a "recent" chip). */
  promoted: boolean;
}

function severityIcon(sev: string): string {
  switch (sev.toLowerCase()) {
    case "critical":
      return "🔴";
    case "warning":
      return "🟡";
    case "info":
      return "🔵";
    default:
      return "⚪";
  }
}

/**
 * Pull alert entities out of scoped memory, oldest first within each
 * entry, newest entry first. Exported for tests.
 */
export function alertsFromMemory(
  entries: readonly MemoryEntry[],
): AlertEntity[] {
  const out: AlertEntity[] = [];
  // Newest entry last, so reverse so newest entry's alerts come first.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    for (const e of entry.entities) {
      if (e.type === "alert") {
        out.push(toEntityFromResolved(e));
      }
    }
  }
  return out;
}

function toEntityFromResolved(
  e: Extract<ResolvedEntity, { type: "alert" }>,
): AlertEntity {
  return {
    id: e.id,
    hash: e.hash,
    title: e.title,
    severity: e.severity,
    // Memory entities don't carry these — pickers fall back to "—".
    projectName: "",
    createdAt: "",
    isResolved: false,
  };
}

/**
 * Merge promoted-from-memory with the fresh cloud list. Dedupe by
 * alert id; promoted version wins (it's what the user just saw).
 * Promoted entries keep their array position; fresh entries get
 * appended below.
 */
export function mergeAlertSources(
  promoted: AlertEntity[],
  fresh: AlertEntity[],
): PickerRow[] {
  const seen = new Set<string>();
  const out: PickerRow[] = [];
  for (const a of promoted) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ entity: a, promoted: true });
  }
  for (const a of fresh) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ entity: a, promoted: false });
  }
  return out;
}

export function AlertPickerSlot({
  spec,
  onPick,
  scopedMemory,
  list = listAlerts,
}: AlertPickerSlotProps) {
  const [fresh, setFresh] = useState<readonly AlertEntity[] | null>(null);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void list(20).then((rows) => {
      if (!cancelled) setFresh(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [list]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const promoted = useMemo<AlertEntity[]>(() => {
    if (!scopedMemory) return [];
    return alertsFromMemory(scopedMemory.recent());
  }, [scopedMemory]);

  const rows = useMemo<PickerRow[]>(
    () => mergeAlertSources(promoted, fresh ?? []),
    [promoted, fresh],
  );

  const filtered = useMemo<PickerRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const e = r.entity;
      if (e.title.toLowerCase().includes(q)) return true;
      if (e.severity.toLowerCase().includes(q)) return true;
      if (e.projectName.toLowerCase().includes(q)) return true;
      if (e.hash && e.hash.toLowerCase().includes(q)) return true;
      if (e.id.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, query]);

  useEffect(() => {
    if (filtered.length === 0) setIdx(0);
    else if (idx >= filtered.length) setIdx(filtered.length - 1);
  }, [filtered, idx]);

  const handlePick = useCallback(
    (entity: AlertEntity) => {
      onPick({
        kind: "alert",
        id: entity.id,
        hash: entity.hash ?? entity.id,
        title: entity.title,
      });
    },
    [onPick],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[idx];
      if (target) handlePick(target.entity);
    }
  };

  // Loading state — fresh === null AND no promoted entries.
  if (fresh === null && promoted.length === 0) {
    return (
      <div
        data-testid="alert-picker-loading"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        Loading alerts…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="alert-picker-empty"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        No alerts in scope. Run <code>/alerts</code> to see what's active.
      </div>
    );
  }

  return (
    <div data-testid="alert-picker">
      <div
        className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md"
        style={{
          background: "var(--bg-elev-2, var(--surface))",
          border: "1px solid var(--border)",
        }}
      >
        <Search size={13} strokeWidth={1.6} style={{ color: "var(--text-faint)" }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={spec.placeholder ?? "Search alerts…"}
          aria-label="Search alerts"
          data-testid="alert-picker-search"
          className="flex-1 bg-transparent text-[13px] outline-none border-none"
          style={{ color: "var(--text)" }}
        />
      </div>
      <ul
        role="listbox"
        aria-label="Alerts"
        className="max-h-[220px] overflow-auto rounded-md"
        style={{ background: "var(--bg-elev-2, var(--surface))" }}
      >
        {filtered.length === 0 ? (
          <li
            className="px-3 py-2 text-[12px]"
            style={{ color: "var(--text-faint)" }}
          >
            No alert matches <code>{query}</code>.
          </li>
        ) : (
          filtered.map((row, i) => {
            const e = row.entity;
            const hashShort = e.hash ? e.hash.slice(0, 8) : "—";
            return (
              <li
                key={e.id}
                role="option"
                aria-selected={i === idx}
                data-testid="alert-picker-row"
                data-promoted={row.promoted ? "true" : undefined}
                data-selected={i === idx ? "true" : undefined}
                onMouseEnter={() => setIdx(i)}
                onClick={() => handlePick(e)}
                className="palette-row px-3 py-2 cursor-pointer"
                style={{ fontSize: 13, color: "var(--text)" }}
              >
                <div className="flex items-center gap-2">
                  <span>{severityIcon(e.severity)}</span>
                  <span className="flex-1 truncate">{e.title}</span>
                  {row.promoted ? (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] tracking-[0.04em] flex items-center gap-1"
                      style={{
                        background: "var(--bg-elev-3, transparent)",
                        color: "var(--text-subtle)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <Clock size={9} strokeWidth={1.6} /> recent
                    </span>
                  ) : null}
                </div>
                <div
                  className="text-[11px] font-mono mt-0.5"
                  style={{ color: "var(--text-faint)" }}
                >
                  {hashShort}
                  {e.projectName ? ` · ${e.projectName}` : ""}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
