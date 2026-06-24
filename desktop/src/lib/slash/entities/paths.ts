/**
 * Inari Live Phase 5.2 — recent-paths entity provider.
 *
 * Wraps the Phase 5.2 `desktop_recent_paths_list` / `..._add` Tauri
 * IPCs (backed by `crate::store::recent_paths`). The path picker
 * reads the top N by recency; the install handler (Phase 5.6) calls
 * `recordRecentPath` on each successful invocation so the picker
 * pre-fills with "the project I was just working on".
 *
 * Catches IPC errors and degrades to empty list / silent no-op so a
 * Tauri-less runtime (vitest / storybook) doesn't surface as a
 * chat-surface error.
 */
import { invoke } from "@tauri-apps/api/core";

import type { PathEntity } from "./types";

/**
 * Wire-level row returned by the Rust IPC. The TS-rs binding lives
 * at `src/lib/types/RecentPath.ts`; we accept the snake-case shape
 * and map to the entity in one place so consumers see a single name.
 */
interface RecentPathRow {
  path: string;
  last_used_at: number;
}

/**
 * Return the most-recently-used absolute paths, capped at `limit`
 * (clamped to [1, 20] in the storage layer). `limit <= 0` returns
 * the full buffer.
 */
export async function listRecentPaths(
  limit = 10,
  deps: { invoke?: typeof invoke } = {},
): Promise<PathEntity[]> {
  const ipc = deps.invoke ?? invoke;
  try {
    const rows = await ipc<RecentPathRow[]>("desktop_recent_paths_list", {
      limit,
    });
    return rows.map((r) => ({
      path: r.path,
      lastUsedAt: r.last_used_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Record that `path` was just used. Idempotent on the path — calling
 * twice updates the timestamp rather than duplicating the row.
 * Best-effort: failure is silent so a transient store hiccup never
 * blocks the slash dispatch that called this.
 *
 * Returns `true` on success, `false` on any error (IPC unavailable,
 * empty path, store error). The boolean is useful for tests; production
 * callers fire-and-forget.
 */
export async function recordRecentPath(
  path: string,
  deps: { invoke?: typeof invoke } = {},
): Promise<boolean> {
  const trimmed = path.trim();
  if (!trimmed) return false;
  const ipc = deps.invoke ?? invoke;
  try {
    await ipc("desktop_recent_paths_add", { path: trimmed });
    return true;
  } catch {
    return false;
  }
}
