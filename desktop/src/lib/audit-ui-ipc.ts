/**
 * S11 — IPC wrappers for the audit-log viewer + per-tool permission
 * settings panel.
 *
 * Mirrors `desktop/src-tauri/src/ipc/audit_ui.rs`. Six commands, all
 * read-only except the two permission setters. The wrapper degrades
 * gracefully when Tauri isn't bound (jsdom tests, plain browser dev) —
 * tests prefer to mock at this boundary via `vi.mock("@/lib/audit-ui-ipc")`
 * rather than stubbing `@tauri-apps/api/core`. This keeps the test
 * surface a typed function call instead of a JSON-RPC string game.
 */

import { invoke } from "@tauri-apps/api/core";

// ── DTO mirrors (kept in sync with Rust) ─────────────────────────────────────

/**
 * Three-level permission. Lowercase to match the
 * `serde(rename_all = "lowercase")` form on the Rust side.
 */
export type PermissionLevel = "auto" | "confirm" | "deny";

/** What the resolver returned to the registry. */
export type PermissionDecision = "allow" | "requires_confirm" | "denied";

/** Sort direction for the audit-log viewer. Defaults to `newest_first`. */
export type AuditOrder = "newest_first" | "oldest_first";

/**
 * One row in `tool_invocations`. Mirrors `agent::AuditEntry` —
 * `serde(rename_all)` is not applied to the parent struct, so each
 * field maps 1:1 to the Rust column name.
 */
/**
 * What kicked off the invoke. Backed by `tool_invocations.source`
 * (migration 0013). Known values today: "agent" (LLM-decided),
 * "slash" (user-typed /<command>), "ambient" (toast/tray click).
 * Reserved for future: "manual" (UI Confirm-button click) and
 * "scheduled" (cron / Quick Action).
 *
 * Wide-typed as `string` because the backend column is TEXT and a
 * future migration may introduce new values. Consumers that switch
 * on this should fall through to a default rather than narrowing.
 */
export type InvocationSource = "agent" | "slash" | "ambient" | "manual" | "scheduled" | (string & {});

export interface AuditEntry {
  id: string;
  tool_name: string;
  session_id: string | null;
  args_json: string;
  result_json: string | null;
  permission: PermissionLevel;
  permission_decision: PermissionDecision;
  witness_receipt_id: string | null;
  started_at_ms: number;
  finished_at_ms: number;
  success: boolean;
  error: string | null;
  /**
   * What triggered the invoke. Mirrors `agent::AuditEntry::source`.
   * `serde(default)` on the Rust side fills "agent" for older rows;
   * the wire format always includes this column post-migration 0013.
   */
  source: InvocationSource;
}

/** Filter shape passed to `desktop_audit_list`. All fields optional. */
export interface AuditFilter {
  text?: string;
  tool_name?: string;
  success?: boolean;
  session_id?: string;
  since_ms?: number;
  until_ms?: number;
  cursor_started_at_ms?: number;
  /** Page size. Defaults to 50, clamped to `[1, 500]` server-side. */
  limit?: number;
  order?: AuditOrder;
}

export interface AuditPage {
  rows: AuditEntry[];
  next_cursor: number | null;
  total: number;
}

/**
 * Three signature states the verifier modal renders. `not_yet_signed`
 * is the honest "Coming in S6" placeholder — receipts today are
 * metadata-only.
 */
export type SignatureStatus =
  | "not_yet_signed"
  | "verified"
  | "failed"
  | "no_receipt";

export interface VerifyResult {
  args_hash_match: boolean;
  result_hash_match: boolean;
  signature: SignatureStatus;
  computed_args_sha256: string;
  recorded_args_sha256: string | null;
  computed_result_sha256: string | null;
  recorded_result_sha256: string | null;
}

export interface PermissionRow {
  name: string;
  description: string;
  default_permission: PermissionLevel;
  override_level: PermissionLevel | null;
}

export interface PermissionListing {
  rows: PermissionRow[];
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
  context: string,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    // jsdom / dev preview path. Surface to console so test failures
    // explain themselves; production hits this only when Tauri is not
    // mounted, which would already be a deeper bug.
    console.info(`[audit-ui-ipc] ${command} unavailable: ${context}`, e);
    return fallback;
  }
}

const EMPTY_PAGE: AuditPage = { rows: [], next_cursor: null, total: 0 };

const EMPTY_LISTING: PermissionListing = { rows: [] };

const FALLBACK_VERIFY: VerifyResult = {
  args_hash_match: false,
  result_hash_match: false,
  signature: "no_receipt",
  computed_args_sha256: "",
  recorded_args_sha256: null,
  computed_result_sha256: null,
  recorded_result_sha256: null,
};

// ── Audit log ───────────────────────────────────────────────────────────────

/**
 * List + filter audit rows. The `filter` argument is a Tauri command
 * struct so we wrap it in `{ filter }` like every other Tauri-bound
 * Rust command that takes a single struct param.
 */
export async function desktopAuditList(filter: AuditFilter): Promise<AuditPage> {
  return invokeOrFallback(
    "desktop_audit_list",
    { filter },
    EMPTY_PAGE,
    "audit list returns empty",
  );
}

/** Single audit row by id. Throws on unknown id (no graceful fallback). */
export async function desktopAuditGet(id: string): Promise<AuditEntry> {
  return invoke<AuditEntry>("desktop_audit_get", { id });
}

/**
 * Re-hash + receipt comparison. Fallback only fires when the IPC
 * itself can't be reached (jsdom / unbound dev) — a failed verification
 * is a real result returned with `*_match: false`, not an exception.
 */
export async function desktopAuditVerify(id: string): Promise<VerifyResult> {
  return invokeOrFallback(
    "desktop_audit_verify",
    { id },
    FALLBACK_VERIFY,
    "verify returns no-receipt fallback",
  );
}

// ── Permission settings ─────────────────────────────────────────────────────

export async function desktopPermissionList(): Promise<PermissionListing> {
  return invokeOrFallback(
    "desktop_permission_list",
    undefined,
    EMPTY_LISTING,
    "permission list returns empty",
  );
}

export async function desktopPermissionSet(
  tool: string,
  level: PermissionLevel,
): Promise<void> {
  await invokeOrFallback(
    "desktop_permission_set",
    { tool, level },
    undefined,
    "no persistence",
  );
}

export async function desktopPermissionClear(tool: string): Promise<void> {
  await invokeOrFallback(
    "desktop_permission_clear",
    { tool },
    undefined,
    "no persistence",
  );
}

// ── Display helpers ─────────────────────────────────────────────────────────

/**
 * Effective permission for a row — override wins when present,
 * otherwise default. The audit log + settings panel both read this
 * (the panel shows it as "current", the table renders the chip).
 */
export function effectivePermission(row: PermissionRow): PermissionLevel {
  return row.override_level ?? row.default_permission;
}

/**
 * Short witness chip label: `verified:<8 hex>` for receipts that have
 * a recorded `args_sha256`, `no-receipt` for rows that pre-date the
 * receipt link (pre-S2 or short-circuit failures). Used by both
 * `WitnessChip.tsx` and `AuditTable.tsx`.
 */
export function witnessChipLabel(receiptId: string | null | undefined): string {
  if (!receiptId) return "no-receipt";
  return `verified:${receiptId.slice(0, 8)}`;
}
