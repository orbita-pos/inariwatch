/**
 * Alert + Fix shapes for the dock's Mode 3 (alert triage) and Mode 4
 * (diff viewer) screens.
 *
 * These types are FRONTEND-ONLY for now — the daemon will eventually
 * surface them through `daemon:event` (Sesión 19+ remediation pipeline)
 * but Sesión 16's scope is the visual surface. The dock store's
 * `currentAlert` / `currentFix` slots are populated either via:
 *
 *   - the Tauri-backed `get_alert_by_id` / `get_fix_by_id` IPC stubs
 *     (deferred to the same sessions),
 *   - tests injecting fixtures via `useChat.openAlert(...)` /
 *     `useChat.openDiff(...)`.
 *
 * The shape is intentionally aligned with `web/lib/db` alert columns
 * so when the daemon ports its alert query layer, the wire mapping is
 * a thin adapter.
 */

export type Severity = "critical" | "high" | "medium" | "low";

export type AlertSource =
  | "sentry"
  | "vercel"
  | "github"
  | "datadog"
  | "expo"
  | "capture"
  | "manual";

/**
 * Minimal alert payload the dock surfaces. The daemon-side alert row
 * carries more (raw event JSON, retry counters, dedup fingerprint, …)
 * but those aren't relevant to the triage UI.
 */
export interface Alert {
  id: string;
  title: string;
  source: AlertSource;
  severity: Severity;
  /** Unix ms when the alert was first received. */
  timestamp: number;
  /** Pre-formatted stack trace string. Empty if the alert has no trace. */
  stackTrace: string;
  /** Shiki language id for the stack trace fence (e.g. `typescript`). */
  stackLanguage: string;
  /** Markdown-rendered AI diagnosis. May be empty until the analysis lands. */
  aiDiagnosis: string;
  /** FK to a Fix that the AI suggested for this alert. Undefined while pending. */
  suggestedFixId?: string;
  metadata: AlertMetadata;
}

export interface AlertMetadata {
  /** 0–100 — AI's confidence in the suggested fix. */
  confidence: number;
  /** 0–100 — risk score of the suggested fix (lower = safer). */
  risk: number;
  /** Net lines changed in the suggested diff (additions + deletions). */
  linesChanged: number;
}

/**
 * 17-gate verdict result. Names match `web/lib/ai/auto-merge-gates.ts`
 * one-for-one so the same names render in the dock and on the cloud
 * dashboard. `pending` is the in-flight state; `skipped` is "this gate
 * does not apply to this fix" (e.g. `eap_chain_verified` skipped when
 * the workspace is not connected to Cortex).
 */
export type GateStatus = "pass" | "fail" | "pending" | "skipped";

export interface GateResult {
  id: string;
  name: string;
  status: GateStatus;
  /** Optional human-readable detail; only shown when status === "fail". */
  detail?: string;
}

/**
 * The 17 gate names from `web/lib/ai/auto-merge-gates.ts`. Stored as a
 * tuple so consumers can iterate in a stable order without re-listing
 * the names. The order matches the code path.
 */
export const GATE_NAMES = [
  "auto_merge_enabled",
  "ci_pass",
  "confidence",
  "lines_changed",
  "self_review",
  "substrate_simulate",
  "eap_chain_verified",
  "prediction_safe",
  "security_scan",
  "substrate_replay",
  "e2e_staging",
  "trust_level",
  "preview_fix_tier",
  "progressive_rollout",
  "fulltrace_v2",
  "var_chain",
  "in_loop_replay",
] as const;

export type GateName = (typeof GATE_NAMES)[number];

export interface Fix {
  id: string;
  alertId: string;
  /** Repo-relative path, e.g. `web/lib/auth.ts`. */
  filePath: string;
  /** Unified-diff string the AI proposed. */
  diff: string;
  /** Shiki language id for the diff content (matches `filePath` extension). */
  language: string;
  /** 17 gate results, ordered to match `GATE_NAMES`. */
  gates: GateResult[];
  /**
   * Substrate replay verdict. `true` = recordings drained bit-exact
   * against the patched code; `false` = at least one divergence; `null`
   * = replay not run yet (gate still pending).
   */
  replayMatch: boolean | null;
  /**
   * Ed25519 signature of the EAP receipt for this fix. `null` until the
   * EAP server signs the chain (Phase 2 of project_eap_local_verify).
   */
  eapSignature: string | null;
}

/**
 * The lookup key the dock uses to open Mode 4 from Mode 3. The dock
 * doesn't carry the entire Fix payload through router state — instead
 * it hands off ids and the screen's `useEffect` resolves the full Fix
 * via `get_fix_by_id` (or a test-injected fixture).
 */
export interface DiffPayload {
  alertId: string;
  fixId: string;
}
