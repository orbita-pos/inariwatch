/**
 * Typed wrapper around Tauri IPC for Inari Live.
 *
 * Re-exports the auto-generated DTOs from `./types/` (regenerated from
 * Rust by `cargo test --test export_types -- --ignored`) and exposes
 * thin async wrappers around `invoke()` plus subscriber helpers for
 * `daemon:event` / `daemon:status_changed`.
 *
 * Heavy-data IPC rule (locked Session 1, ARCHITECTURE.md): never call
 * an `invoke()` that returns embeddings, full ASTs, lists with > 10k
 * entries, or diffs > 100 KB. Heavy data flows over the local MCP
 * HTTP transport on `127.0.0.1:9876` (Session 7).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { DaemonStatusDto } from "./types/DaemonStatusDto";
import type { IpcError } from "./types/IpcError";
import type { LogEntryDto } from "./types/LogEntryDto";
import type { RepoDto } from "./types/RepoDto";

export type { DaemonStatusDto, IpcError, LogEntryDto, RepoDto };

/**
 * Bus events delivered on `daemon:event`. Mirrors the
 * `crate::daemon::DaemonEvent` enum (`#[serde(tag = "kind")]`).
 * Keep the union open for forward-compat — sensors add variants.
 */
export type DaemonEvent =
  | { kind: "heartbeat"; uptime_secs: number }
  | { kind: "shutdown" }
  // Forward-compat: future sensors may emit additional variants.
  | { kind: string; [key: string]: unknown };

/** Tauri event channel names emitted by Session 4's `ipc::events`. */
export const DAEMON_EVENT_CHANNEL = "daemon:event" as const;
export const DAEMON_STATUS_CHANGED_CHANNEL = "daemon:status_changed" as const;

// ─────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────

/** Snapshot of daemon liveness + counts. */
export async function daemonStatus(): Promise<DaemonStatusDto> {
  return invoke<DaemonStatusDto>("daemon_status");
}

/** All opened repos, slim shape (no embeddings, no AST data). Capped at 1000. */
export async function listRepos(): Promise<RepoDto[]> {
  return invoke<RepoDto[]>("list_repos");
}

/** Register a folder as a tracked repo. Path must exist + be a directory. */
export async function openRepo(path: string): Promise<RepoDto> {
  return invoke<RepoDto>("open_repo", { path });
}

/** Unregister a repo by id. Cascades event rows. */
export async function closeRepo(id: string): Promise<void> {
  return invoke<void>("close_repo", { id });
}

/** Tail the most-recent log file. Caps at 200 entries. Optional level filter. */
export async function getLogs(level?: string): Promise<LogEntryDto[]> {
  return invoke<LogEntryDto[]>("get_logs", { level });
}

// ─────────────────────────────────────────────────────────────────────
// Event subscribers
// ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to every daemon bus event in real time. Returns an
 * `unlisten` function the caller MUST call on teardown to avoid leaks.
 */
export async function onDaemonEvent(
  handler: (event: DaemonEvent) => void,
): Promise<UnlistenFn> {
  return listen<DaemonEvent>(DAEMON_EVENT_CHANNEL, (msg) => handler(msg.payload));
}

/**
 * Subscribe to debounced status snapshots (1s max cadence; identical
 * payloads suppressed). Returns an `unlisten` function.
 */
export async function onDaemonStatusChanged(
  handler: (status: DaemonStatusDto) => void,
): Promise<UnlistenFn> {
  return listen<DaemonStatusDto>(DAEMON_STATUS_CHANGED_CHANNEL, (msg) =>
    handler(msg.payload),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Type guard for the discriminated `IpcError` union returned by
 * commands that propagate `StoreError`. Plain string errors (legacy
 * commands like `desktop_auth_*`) fail this guard — handle those
 * with `typeof err === "string"`.
 */
export function isIpcError(err: unknown): err is IpcError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in (err as Record<string, unknown>) &&
    typeof (err as { kind: unknown }).kind === "string"
  );
}
