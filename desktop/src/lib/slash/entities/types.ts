/**
 * Inari Live Phase 5.2 — entity types consumed by the slot pickers.
 *
 * Each entity is the deterministic data the picker needs to render +
 * the dispatcher needs to resume. Pickers may collapse richer
 * underlying records (CloudAlert, ProjectRow, …) into these shapes
 * at the boundary so the picker layer doesn't drift with the cloud
 * schema.
 *
 * Why a separate `types.ts` instead of inlining: the four pickers
 * import their types in isolation; a shared module lets the
 * dispatcher (and tests) reference any entity without dragging in
 * the IPC providers each provider wraps.
 */

/** Paired WhatsApp / Telegram / Slack recipient. */
export interface ContactEntity {
  /**
   * Wire address — E.164 phone for WhatsApp (`+5215512345678`),
   * chat id for Telegram, channel id for Slack. Goes verbatim into
   * the underlying tool's recipient arg.
   */
  jid: string;
  /** User-facing display name. Shown in the picker rows + header. */
  name: string;
  /**
   * Redacted variant of `jid` for disambiguation when two contacts
   * share the same `name`. E.g. `"+52 ••••5678"`. Same shape the
   * pairing IPC returns.
   */
  redacted: string;
}

/** Workspace project — used by `/health`, `/uptime <project>`, etc. */
export interface ProjectEntity {
  id: string;
  name: string;
  slug: string;
  /** "Personal" for personal-workspace rows, or the org name. */
  workspaceName: string | null;
  /**
   * Lifecycle state. Mirrors the cloud `ProjectState` union; carried
   * loose so a new state lands in the cloud doesn't break the picker.
   */
  state: string;
  /**
   * Optional local repo path. Populated when the project is
   * locally-linked (Add Project Wizard recorded a clone path). Lets
   * the project picker double as a "open the right repo" shortcut.
   */
  localPath?: string;
}

/** Single alert — used by `/fix`, `/silence`, `/ack`. */
export interface AlertEntity {
  id: string;
  /**
   * The 16-hex `inariHash` (when present) — what `/alert` and `/fix`
   * accept as their canonical alert reference. May be null on legacy
   * alerts; the picker keeps those visible so the user can still
   * select them by id.
   */
  hash: string | null;
  title: string;
  severity: string;
  /** Project the alert belongs to. Drives the picker's secondary line. */
  projectName: string;
  /** ISO timestamp — picker shows "5m ago" via `timeAgo` in handlers.ts. */
  createdAt: string;
  isResolved: boolean;
}

/** Recent workspace path — used by `/install`, `/health`. */
export interface PathEntity {
  /**
   * Absolute filesystem path. Verbatim what the user typed; we don't
   * normalise (so e.g. `D:\web` stays distinct from `d:\web` if the
   * user typed both — which they shouldn't, but the buffer is honest).
   */
  path: string;
  /** Unix milliseconds. Picker renders relative time + sorts by recency. */
  lastUsedAt: number;
}
