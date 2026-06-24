/**
 * Typed wrappers for the Fix Locally IPC commands.
 * Mirrors `desktop/src-tauri/src/ipc/project_local.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Persist the local clone path for a project.
 * Pass an empty string to clear a previously configured path.
 * Rejects if the path is set but is not an existing directory.
 */
export async function projectSetLocalPath(
  projectId: string,
  path: string,
): Promise<void> {
  await invoke("project_set_local_path", { projectId, path });
}

/**
 * Read the local clone path for a project.
 * Returns `null` when the user hasn't configured one yet.
 */
export async function projectGetLocalPath(
  projectId: string,
): Promise<string | null> {
  return invoke<string | null>("project_get_local_path", { projectId });
}

/**
 * Point the file-tools `workspace_root` at `path` so that read_file /
 * write_file sandbox calls resolve relative to the chosen project clone.
 * Wraps `desktop_save_watch_dir` (sets the `watch_dir` settings key read
 * by `LocalExecBackends::from_app`).
 */
export async function activateLocalPath(path: string): Promise<void> {
  await invoke("desktop_save_watch_dir", { path });
}

/**
 * Open the native folder picker. Returns the selected path, or `null`
 * when the user cancels. Wraps `desktop_pick_watch_dir`.
 */
export async function pickLocalFolder(): Promise<string | null> {
  return invoke<string | null>("desktop_pick_watch_dir");
}
