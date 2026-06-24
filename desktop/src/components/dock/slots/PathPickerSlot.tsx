/**
 * Phase 5.6 — recent-paths picker + native folder browse.
 *
 * Shows the recent absolute paths from Phase 5.2's recent_paths
 * SQLite buffer (newest first) and a "Browse…" button that opens the
 * native folder dialog. Users coming back to `/install` after a
 * previous session see "that folder I was just working in" without
 * re-typing.
 *
 * The picker resolves to `{kind: "path", value: <absolute path>}`;
 * the slot dispatcher merges that into the partial command and
 * resumes the install handler.
 */
import { invoke } from "@tauri-apps/api/core";
import { Folder, FolderSearch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  listRecentPaths,
  type PathEntity,
} from "@/lib/slash/entities/paths";
import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";

export interface PathPickerSlotProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  /** Test injection — override the recent-paths IPC. */
  list?: typeof listRecentPaths;
  /**
   * Test injection — replaces the native folder dialog so tests
   * don't try to spawn a Tauri-only system surface.
   */
  pickFolder?: () => Promise<string | null>;
}

/**
 * Default folder picker — wraps the `desktop_pick_watch_dir` IPC. Used
 * by the onboarding wizard too; the title is generic enough to reuse.
 * Returns `null` on cancel / runtime error; the picker stays open so
 * the user can retry.
 */
async function defaultPickFolder(): Promise<string | null> {
  try {
    const result = await invoke<string | null>("desktop_pick_watch_dir");
    return result ?? null;
  } catch {
    return null;
  }
}

export function PathPickerSlot({
  spec,
  onPick,
  list = listRecentPaths,
  pickFolder = defaultPickFolder,
}: PathPickerSlotProps) {
  const [paths, setPaths] = useState<readonly PathEntity[] | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void list(10).then((rows) => {
      if (!cancelled) setPaths(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [list]);

  const handlePick = useCallback(
    (path: string) => {
      onPick({ kind: "path", value: path });
    },
    [onPick],
  );

  const handleBrowse = useCallback(async () => {
    const picked = await pickFolder();
    if (picked) handlePick(picked);
  }, [handlePick, pickFolder]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!paths || paths.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, paths.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = paths[idx];
      if (target) handlePick(target.path);
    }
  };

  // Loading state
  if (paths === null) {
    return (
      <div
        data-testid="path-picker-loading"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        Loading recent folders…
      </div>
    );
  }

  // Empty state — straight to Browse.
  if (paths.length === 0) {
    return (
      <div data-testid="path-picker-empty" className="py-4 px-3 text-center">
        <div
          className="text-[12px] mb-2"
          style={{ color: "var(--text-faint)" }}
        >
          No recent folders. Pick one to install into.
        </div>
        <button
          type="button"
          onClick={handleBrowse}
          data-testid="path-picker-browse"
          className="px-3 py-1.5 rounded-md text-[12px] flex items-center justify-center gap-1.5 mx-auto"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            color: "var(--text)",
            border: "1px solid var(--border)",
          }}
        >
          <FolderSearch size={13} strokeWidth={1.6} />
          Browse…
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="path-picker"
      tabIndex={0}
      onKeyDown={onKey}
      className="outline-none"
    >
      <ul
        role="listbox"
        aria-label={spec.prompt}
        className="max-h-[180px] overflow-auto rounded-md"
        style={{ background: "var(--bg-elev-2, var(--surface))" }}
      >
        {paths.map((p, i) => (
          <li
            key={p.path}
            role="option"
            aria-selected={i === idx}
            data-testid="path-picker-row"
            data-selected={i === idx ? "true" : undefined}
            onMouseEnter={() => setIdx(i)}
            onClick={() => handlePick(p.path)}
            className="palette-row px-3 py-1.5 cursor-pointer flex items-center gap-2"
            style={{
              fontSize: 13,
              color: "var(--text)",
            }}
          >
            <Folder size={13} strokeWidth={1.6} style={{ color: "var(--text-subtle)" }} />
            <span className="font-mono truncate">{p.path}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={handleBrowse}
        data-testid="path-picker-browse"
        className="mt-2 w-full px-3 py-1.5 rounded-md text-[12px] flex items-center justify-center gap-1.5"
        style={{
          background: "var(--bg-elev-2, var(--surface))",
          color: "var(--text-subtle)",
          border: "1px dashed var(--border)",
        }}
      >
        <FolderSearch size={12} strokeWidth={1.8} />
        Browse for a different folder…
      </button>
    </div>
  );
}
