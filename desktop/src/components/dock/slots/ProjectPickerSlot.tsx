/**
 * Phase 5.8 — project picker (with scoped-memory promotion).
 *
 * Mirrors AlertPickerSlot's promote → fresh fallback pattern:
 *   1. Reads recent project entities out of scoped memory and
 *      surfaces them up top with a "recent" chip.
 *   2. Falls back to `listProjects()` for the canonical workspace
 *      list. Dedupes by id; promoted wins.
 *
 * Picking dispatches `{kind: "project", id, name, path?}`. The
 * dispatcher's `mergeSlotValue` lifts `name → <slot>_display` and
 * `path → <slot>_path`; the rebuild reads the canonical `id` as
 * the positional `project_id`.
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
  listProjects,
  type ProjectEntity,
} from "@/lib/slash/entities/projects";
import type {
  MemoryEntry,
  ResolvedEntity,
  ScopedMemory,
} from "@/lib/slash/scoped-memory";
import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";

export interface ProjectPickerSlotProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  scopedMemory?: ScopedMemory;
  list?: typeof listProjects;
}

interface PickerRow {
  entity: ProjectEntity;
  promoted: boolean;
}

/** Pull project entities out of scoped memory, newest entry first. */
export function projectsFromMemory(
  entries: readonly MemoryEntry[],
): ProjectEntity[] {
  const out: ProjectEntity[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    for (const e of entry.entities) {
      if (e.type === "project") {
        out.push(toEntityFromResolved(e));
      }
    }
  }
  return out;
}

function toEntityFromResolved(
  e: Extract<ResolvedEntity, { type: "project" }>,
): ProjectEntity {
  return {
    id: e.id,
    name: e.name,
    slug: e.slug ?? "",
    workspaceName: null,
    state: "—",
    localPath: e.path,
  };
}

/**
 * Merge promoted (memory) + fresh (cloud). Promoted wins on dedupe
 * because the user just saw it; fresh has more fields (state,
 * workspaceName) but we don't want to discard the recency signal.
 *
 * When the promoted entity has a missing field (state == "—") AND
 * the fresh duplicate has it, we patch the promoted row from the
 * fresh data so the picker can still render the lifecycle pill.
 */
export function mergeProjectSources(
  promoted: ProjectEntity[],
  fresh: ProjectEntity[],
): PickerRow[] {
  const freshById = new Map(fresh.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: PickerRow[] = [];
  for (const p of promoted) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const merged: ProjectEntity = freshById.has(p.id)
      ? {
          ...freshById.get(p.id)!,
          // Keep promoted's localPath when set; fall back to fresh.
          localPath: p.localPath ?? freshById.get(p.id)!.localPath,
        }
      : p;
    out.push({ entity: merged, promoted: true });
  }
  for (const p of fresh) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({ entity: p, promoted: false });
  }
  return out;
}

function stateIcon(state: string): string {
  switch (state) {
    case "live":
      return "🟢";
    case "warning":
      return "🟡";
    case "critical":
      return "🔴";
    case "needs_setup":
    case "created":
    case "setting_up":
      return "🟠";
    default:
      return "⚪";
  }
}

export function ProjectPickerSlot({
  spec,
  onPick,
  scopedMemory,
  list = listProjects,
}: ProjectPickerSlotProps) {
  const [fresh, setFresh] = useState<readonly ProjectEntity[] | null>(null);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void list().then((rows) => {
      if (!cancelled) setFresh(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [list]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const promoted = useMemo<ProjectEntity[]>(() => {
    if (!scopedMemory) return [];
    return projectsFromMemory(scopedMemory.recent());
  }, [scopedMemory]);

  const rows = useMemo<PickerRow[]>(
    () => mergeProjectSources(promoted, fresh ?? []),
    [promoted, fresh],
  );

  const filtered = useMemo<PickerRow[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const e = r.entity;
      if (e.name.toLowerCase().includes(q)) return true;
      if (e.slug.toLowerCase().includes(q)) return true;
      if (e.id.toLowerCase().includes(q)) return true;
      if (e.workspaceName && e.workspaceName.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, query]);

  useEffect(() => {
    if (filtered.length === 0) setIdx(0);
    else if (idx >= filtered.length) setIdx(filtered.length - 1);
  }, [filtered, idx]);

  const handlePick = useCallback(
    (entity: ProjectEntity) => {
      onPick({
        kind: "project",
        id: entity.id,
        name: entity.name,
        path: entity.localPath,
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

  if (fresh === null && promoted.length === 0) {
    return (
      <div
        data-testid="project-picker-loading"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        Loading projects…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="project-picker-empty"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        No projects in your workspace yet. Run <code>/install &lt;path&gt;</code> to add one.
      </div>
    );
  }

  return (
    <div data-testid="project-picker">
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
          placeholder={spec.placeholder ?? "Search projects…"}
          aria-label="Search projects"
          data-testid="project-picker-search"
          className="flex-1 bg-transparent text-[13px] outline-none border-none"
          style={{ color: "var(--text)" }}
        />
      </div>
      <ul
        role="listbox"
        aria-label="Projects"
        className="max-h-[220px] overflow-auto rounded-md"
        style={{ background: "var(--bg-elev-2, var(--surface))" }}
      >
        {filtered.length === 0 ? (
          <li
            className="px-3 py-2 text-[12px]"
            style={{ color: "var(--text-faint)" }}
          >
            No project matches <code>{query}</code>.
          </li>
        ) : (
          filtered.map((row, i) => {
            const e = row.entity;
            return (
              <li
                key={e.id}
                role="option"
                aria-selected={i === idx}
                data-testid="project-picker-row"
                data-promoted={row.promoted ? "true" : undefined}
                data-selected={i === idx ? "true" : undefined}
                onMouseEnter={() => setIdx(i)}
                onClick={() => handlePick(e)}
                className="palette-row px-3 py-2 cursor-pointer"
                style={{ fontSize: 13, color: "var(--text)" }}
              >
                <div className="flex items-center gap-2">
                  <span>{stateIcon(e.state)}</span>
                  <span className="flex-1 truncate">{e.name}</span>
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
                  {e.id.slice(0, 8)}
                  {e.workspaceName ? ` · ${e.workspaceName}` : ""}
                  {e.localPath ? ` · ${e.localPath}` : ""}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
