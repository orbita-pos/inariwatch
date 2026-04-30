/**
 * Dock-specific IPC helpers + stubs.
 *
 * The dock surface (Sesión 15) needs five reads — repo+branch+changes,
 * index stats, recent activity, alert list, and a way to open the main
 * window — but only the first is fully wired today (`list_repos` from
 * Sesión 4 + `daemon_status` from Sesión 2).
 *
 * The other four sit behind stub commands invoked by name; if the
 * Tauri command isn't registered yet, `invoke()` rejects with `"command
 * <name> not found"` and we fall back to a deterministic mock so the
 * surface still renders. Sesión 17 (Settings + main window) wires
 * `open_main_window` and `hide_dock`. Sesión 19 (remediation) wires
 * `list_recent_alerts` + `search_codebase` calls (or the MCP HTTP path
 * lands first in Sesión 7).
 */

import { invoke } from "@tauri-apps/api/core";

import { listRepos, type DaemonStatusDto, type RepoDto } from "@/lib/ipc";
import { useAppState } from "@/lib/store/useAppState";

export interface ActiveRepoSummary {
  id: string;
  name: string;
  /** Best-effort branch label. Empty string if we can't resolve. */
  branch: string;
  /** Number of FsChange events observed in the last 60s. */
  changes: number;
}

export interface IndexStats {
  symbolCount: number;
  /** Unix ms when the last index pass finished, or null if never. */
  lastIndexedAtMs: number | null;
}

/**
 * Resolve the active repo. The dock cares about the repo the user has
 * focused — `useAppState.activeRepoId` carries that selection. If it's
 * unset, fall back to the most-recently-opened repo (per `list_repos`
 * sort, last entry by default — which Sesión 4's command already
 * orders by `opened_at_ms`).
 */
export async function resolveActiveRepo(): Promise<ActiveRepoSummary | null> {
  let repos: RepoDto[] = [];
  try {
    repos = await listRepos();
  } catch {
    return null;
  }
  if (repos.length === 0) return null;

  const activeId = useAppState.getState().activeRepoId;
  const repo = repos.find((r) => r.id === activeId) ?? repos[repos.length - 1];
  if (!repo) return null;

  // Branch resolution. Sesión 8 owns `git_status` IPC; if it's not
  // registered, return an empty string — the dock renders "no branch"
  // gracefully.
  let branch = "";
  try {
    branch = (await invoke<string>("git_current_branch", { repoId: repo.id })) ?? "";
  } catch {
    branch = "";
  }
  return { id: repo.id, name: repo.name, branch, changes: 0 };
}

/**
 * Pull index stats. Sesión 6 ships an `indexer_stats` command for the
 * main window's index status row; until that's wired here we synthesize
 * stats from `daemon_status` (the daemon already exposes a sensor +
 * repo count). Tests use the `mockIndexStats` injection point below.
 */
export async function fetchIndexStats(): Promise<IndexStats> {
  try {
    const stats = await invoke<{
      symbol_count?: number;
      last_indexed_at_ms?: number | null;
    }>("indexer_stats");
    return {
      symbolCount: Number(stats.symbol_count ?? 0),
      lastIndexedAtMs: stats.last_indexed_at_ms ?? null,
    };
  } catch {
    // Fallback: best-effort using daemon status. Sesión 6's real impl
    // replaces this once the IPC lands.
    try {
      const status = await invoke<DaemonStatusDto>("daemon_status");
      return {
        symbolCount: 0,
        lastIndexedAtMs: status ? Date.now() : null,
      };
    } catch {
      return { symbolCount: 0, lastIndexedAtMs: null };
    }
  }
}

export async function openMainWindow(tab?: string): Promise<void> {
  try {
    await invoke("open_main_window", { tab: tab ?? null });
  } catch {
    console.info("[dock-ipc] open_main_window not registered — will land in Sesión 17");
  }
}

export async function hideDock(): Promise<void> {
  try {
    await invoke("hide_dock");
  } catch {
    // The global shortcut owns the hide path on the Rust side; the
    // command form below it lands in Sesión 17.
    console.info("[dock-ipc] hide_dock not registered — using ESC fallback");
  }
}

export interface SearchHit {
  id: string;
  path: string;
  preview: string;
}

export async function searchCodebase(query: string): Promise<SearchHit[]> {
  if (!query.trim()) return [];
  try {
    return await invoke<SearchHit[]>("search_codebase", { query });
  } catch {
    return [];
  }
}

export interface RecentAlert {
  id: string;
  title: string;
  source: string;
  receivedAtMs: number;
}

export async function listRecentAlerts(): Promise<RecentAlert[]> {
  try {
    return await invoke<RecentAlert[]>("list_recent_alerts");
  } catch {
    return [];
  }
}
