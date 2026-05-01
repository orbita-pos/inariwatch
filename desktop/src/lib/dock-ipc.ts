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
import type { Alert, Fix } from "@/types/alert";

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

// ──────────────────────────────────────────────────────────────────────
// Sesión 16 — alert triage (Mode 3) + diff viewer (Mode 4) IPC stubs
//
// These six commands are NOT registered on the Rust side yet — they
// land alongside the remediation pipeline (Sesión 17 + 19). Each
// degrades gracefully: the Tauri-less path returns either a benign
// fallback (success: false, mock data) or a console.info breadcrumb so
// the dock surface stays interactive while the backend catches up.
// ──────────────────────────────────────────────────────────────────────

export interface ApplyFixResult {
  success: boolean;
  /** Optional Vercel/staging deployment URL when the apply triggers a deploy. */
  deploymentUrl?: string;
  /** Surface-formatted error for the failure UI ("Network unavailable", …). */
  message?: string;
}

export async function applyFix(
  alertId: string,
  fixId: string,
): Promise<ApplyFixResult> {
  try {
    return await invoke<ApplyFixResult>("apply_fix", { alertId, fixId });
  } catch {
    console.info(
      "[dock-ipc] apply_fix not registered — deferred to Sesión 17/19. " +
        `(alertId=${alertId}, fixId=${fixId})`,
    );
    return { success: false, message: "Backend not available in dev build" };
  }
}

export interface RejectFixResult {
  success: boolean;
}

export async function rejectFix(
  fixId: string,
  reason?: string,
): Promise<RejectFixResult> {
  try {
    return await invoke<RejectFixResult>("reject_fix", {
      fixId,
      reason: reason ?? null,
    });
  } catch {
    console.info(
      `[dock-ipc] reject_fix not registered — deferred to Sesión 19. (fixId=${fixId})`,
    );
    return { success: false };
  }
}

export async function openInEditor(
  filePath: string,
  lineNumber?: number,
): Promise<void> {
  try {
    await invoke("open_in_editor", {
      filePath,
      lineNumber: lineNumber ?? null,
    });
  } catch {
    console.info(
      `[dock-ipc] open_in_editor not registered — deferred to Sesión 17. (file=${filePath}, line=${lineNumber ?? "?"})`,
    );
  }
}

export interface ModifyWithAiResult {
  success: boolean;
  /** Replacement diff string when the modification produced a new patch. */
  newDiff?: string;
  message?: string;
}

export async function modifyWithAi(
  fixId: string,
  instruction: string,
): Promise<ModifyWithAiResult> {
  try {
    return await invoke<ModifyWithAiResult>("modify_with_ai", {
      fixId,
      instruction,
    });
  } catch {
    console.info(
      `[dock-ipc] modify_with_ai not registered — deferred to Sesión 19. (fixId=${fixId})`,
    );
    return { success: false, message: "Modify-with-AI ships in Sesión 19" };
  }
}

export async function getAlertById(alertId: string): Promise<Alert | null> {
  try {
    return await invoke<Alert | null>("get_alert_by_id", { alertId });
  } catch {
    return null;
  }
}

export async function getFixById(fixId: string): Promise<Fix | null> {
  try {
    return await invoke<Fix | null>("get_fix_by_id", { fixId });
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sesión 19 — local remediation pipeline real wiring
//
// Replaces the Sesión 16 `applyFix` / `rejectFix` heuristic stubs. The
// dock now calls the daemon's orchestrator directly:
//   - `startRemediation` kicks off a session (local single-shot OR
//     cloud-proxied) and returns the session row + an embedded draft
//     when local.
//   - `applyRemediation` writes the cached draft to disk + commits.
//   - `rejectRemediation` persists the rejection + emits the bus event.
//   - `getRemediationSession` re-reads current state on remount.
//
// Each helper degrades gracefully under jsdom / older daemon builds —
// invoke rejects with "command <name> not found" → fallback returns a
// no-op shape so the dock surface stays interactive.
// ──────────────────────────────────────────────────────────────────────

export interface RemediationDraftDto {
  sessionId: string;
  diffUnified: string;
  filesTouched: string[];
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  cents: number;
}

export interface RemediationSessionDto {
  sessionId: string;
  mode: "local" | "cloud";
  state: "pending" | "draft" | "applied" | "rejected" | "failed";
  draft?: RemediationDraftDto | null;
  prUrl?: string | null;
}

export async function startRemediation(args: {
  repoId: string;
  errorMessage: string;
  stackTrace?: string;
  errorFingerprint?: string;
  fileHint?: string;
}): Promise<RemediationSessionDto | null> {
  try {
    const raw = await invoke<{
      session_id: string;
      mode: string;
      state: string;
      draft?: {
        session_id: string;
        diff_unified: string;
        files_touched: string[];
        model_used: string;
        prompt_tokens: number;
        completion_tokens: number;
        cents: number;
      } | null;
      pr_url?: string | null;
    }>("start_remediation", {
      args: {
        repo_id: args.repoId,
        error_message: args.errorMessage,
        stack_trace: args.stackTrace ?? null,
        error_fingerprint: args.errorFingerprint ?? null,
        file_hint: args.fileHint ?? null,
      },
    });
    return {
      sessionId: raw.session_id,
      mode: raw.mode === "cloud" ? "cloud" : "local",
      state: (raw.state as RemediationSessionDto["state"]) ?? "pending",
      draft: raw.draft
        ? {
            sessionId: raw.draft.session_id,
            diffUnified: raw.draft.diff_unified,
            filesTouched: raw.draft.files_touched,
            modelUsed: raw.draft.model_used,
            promptTokens: raw.draft.prompt_tokens,
            completionTokens: raw.draft.completion_tokens,
            cents: raw.draft.cents,
          }
        : null,
      prUrl: raw.pr_url ?? null,
    };
  } catch (e) {
    console.info(
      `[dock-ipc] start_remediation rejected (${e instanceof Error ? e.message : "?"}); ` +
        "deferred to a daemon build that registers the command",
    );
    return null;
  }
}

export interface ApplyRemediationDto {
  success: boolean;
  commitSha: string | null;
  filesTouched: string[];
  message: string;
}

export async function applyRemediation(
  sessionId: string,
): Promise<ApplyRemediationDto> {
  try {
    const raw = await invoke<{
      success: boolean;
      commit_sha: string | null;
      files_touched: string[];
      message: string;
    }>("apply_remediation", { args: { session_id: sessionId } });
    return {
      success: raw.success,
      commitSha: raw.commit_sha ?? null,
      filesTouched: raw.files_touched ?? [],
      message: raw.message,
    };
  } catch (e) {
    console.info(
      `[dock-ipc] apply_remediation rejected (${e instanceof Error ? e.message : "?"})`,
    );
    return {
      success: false,
      commitSha: null,
      filesTouched: [],
      message: "Backend not available in dev build",
    };
  }
}

export async function rejectRemediation(
  sessionId: string,
  reason?: string,
): Promise<{ success: boolean }> {
  try {
    await invoke("reject_remediation", {
      args: { session_id: sessionId, reason: reason ?? null },
    });
    return { success: true };
  } catch (e) {
    console.info(
      `[dock-ipc] reject_remediation rejected (${e instanceof Error ? e.message : "?"})`,
    );
    return { success: false };
  }
}

export interface RemediationSessionState {
  sessionId: string;
  repoId: string;
  mode: string;
  state: string;
  draftDiff: string | null;
  filesTouched: string[];
  prUrl: string | null;
  commitSha: string | null;
  errorMessage: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export async function getRemediationSession(
  sessionId: string,
): Promise<RemediationSessionState | null> {
  try {
    const raw = await invoke<{
      session_id: string;
      repo_id: string;
      mode: string;
      state: string;
      draft_diff: string | null;
      files_touched: string[];
      pr_url: string | null;
      commit_sha: string | null;
      error_message: string | null;
      created_at_ms: number;
      completed_at_ms: number | null;
    } | null>("get_remediation_session_cmd", { args: { session_id: sessionId } });
    if (!raw) return null;
    return {
      sessionId: raw.session_id,
      repoId: raw.repo_id,
      mode: raw.mode,
      state: raw.state,
      draftDiff: raw.draft_diff,
      filesTouched: raw.files_touched ?? [],
      prUrl: raw.pr_url,
      commitSha: raw.commit_sha,
      errorMessage: raw.error_message,
      createdAtMs: raw.created_at_ms,
      completedAtMs: raw.completed_at_ms,
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sesión 20 — pre-push gate runner UI surface
//
// Mode 5 (`GateRunning`) consumes these two reads. Both degrade
// gracefully under jsdom / older daemon builds — invoke rejects with
// "command <name> not found" → fallback returns a no-op shape so the
// dock surface stays interactive.
// ──────────────────────────────────────────────────────────────────────

export interface GateRunSummaryDto {
  runId: string;
  repoId: string;
  sha: string;
  ref: string;
  allowed: boolean;
  blockingGates: string[];
  totalLatencyMs: number;
  createdAtMs: number;
  overrideUsed: boolean;
  overrideReason: string | null;
}

export async function getRecentGateRuns(
  repoId: string,
  limit: number = 20,
): Promise<GateRunSummaryDto[]> {
  try {
    const raw = await invoke<
      {
        run_id: string;
        repo_id: string;
        sha: string;
        ref_: string;
        allowed: boolean;
        blocking_gates: string[];
        total_latency_ms: number;
        created_at_ms: number;
        override_used: boolean;
        override_reason: string | null;
      }[]
    >("get_recent_gate_runs", { args: { repo_id: repoId, limit } });
    return raw.map((r) => ({
      runId: r.run_id,
      repoId: r.repo_id,
      sha: r.sha,
      ref: r.ref_,
      allowed: r.allowed,
      blockingGates: r.blocking_gates ?? [],
      totalLatencyMs: r.total_latency_ms,
      createdAtMs: r.created_at_ms,
      overrideUsed: r.override_used,
      overrideReason: r.override_reason,
    }));
  } catch {
    return [];
  }
}

export async function requestBypass(
  runId: string,
  reason?: string,
): Promise<{ success: boolean }> {
  try {
    await invoke("request_bypass", {
      args: { run_id: runId, reason: reason ?? null },
    });
    return { success: true };
  } catch (e) {
    console.info(
      `[dock-ipc] request_bypass rejected (${e instanceof Error ? e.message : "?"})`,
    );
    return { success: false };
  }
}

/**
 * Open the EAP receipt detail surface for a given signature. Sesión 17
 * lands the main-window receipt route; until then we log the request
 * so testers can confirm the click reached the IPC layer.
 */
export async function openEapReceipt(signature: string): Promise<void> {
  try {
    await invoke("open_eap_receipt", { signature });
  } catch {
    console.info(
      `[dock-ipc] open_eap_receipt not registered — deferred to Sesión 17. (sig=${signature.slice(0, 12)}…)`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// Sesión 27 — EAP receipt chip + Replay-against-patch button
//
// Two reads:
//   * `getReceiptForSession` — populates `EAPReceiptChip` with the
//     mirrored EAP attestation (Merkle root, prompt hash, tools called,
//     files read, model, signature). Heavy fields ride as JSON strings
//     to keep the IPC schema-agnostic; the chip's popover decodes them.
//   * `replayAgainstPatch` — POSTs to the existing `/v2/replay` Hetzner
//     endpoint via the daemon. Returns a tagged union the dock branches
//     on — verdict / no recording / no receipt / config missing /
//     request failed.
//
// Both helpers degrade gracefully under jsdom + older daemon builds:
// invoke rejects with "command <name> not found" → fallback returns
// `null` (chip) or `request_failed` (button), so the surface stays
// interactive without throwing.
// ──────────────────────────────────────────────────────────────────────

export interface EapReceiptDto {
  receiptId: string;
  remediationSessionId: string;
  merkleRoot: string;
  signature: string | null;
  signed: boolean;
  promptHash: string | null;
  systemPrompt: string | null;
  /** JSON-encoded array. Free shape — caller decodes. */
  toolsCalledJson: string;
  /** JSON-encoded array. Free shape — caller decodes. */
  filesReadJson: string;
  model: string | null;
  recordingId: string | null;
  attestor: string;
  createdAtMs: number;
}

export async function getReceiptForSession(
  sessionId: string,
): Promise<EapReceiptDto | null> {
  try {
    const raw = await invoke<{
      receipt_id: string;
      remediation_session_id: string;
      merkle_root: string;
      signature: string | null;
      signed: boolean;
      prompt_hash: string | null;
      system_prompt: string | null;
      tools_called_json: string;
      files_read_json: string;
      model: string | null;
      recording_id: string | null;
      attestor: string;
      created_at_ms: number;
    } | null>("get_receipt_for_session", { args: { session_id: sessionId } });
    if (!raw) return null;
    return {
      receiptId: raw.receipt_id,
      remediationSessionId: raw.remediation_session_id,
      merkleRoot: raw.merkle_root,
      signature: raw.signature,
      signed: raw.signed,
      promptHash: raw.prompt_hash,
      systemPrompt: raw.system_prompt,
      toolsCalledJson: raw.tools_called_json,
      filesReadJson: raw.files_read_json,
      model: raw.model,
      recordingId: raw.recording_id,
      attestor: raw.attestor,
      createdAtMs: raw.created_at_ms,
    };
  } catch {
    return null;
  }
}

export interface ReplayHeadThrow {
  exceptionName: string;
  exceptionMessage: string;
  topFrameFunction: string | null;
  topFrameFile: string | null;
  topFrameLine: number | null;
}

export type ReplayResultDto =
  | {
      kind: "ok";
      throwReproduced: boolean;
      throwsAfter: number;
      runnerMode: string | null;
      fixBranch: string | null;
      durationMs: number | null;
      headThrow: ReplayHeadThrow | null;
    }
  | { kind: "no_recording"; receiptId: string }
  | { kind: "no_receipt" }
  | { kind: "config_missing"; reason: string }
  | { kind: "request_failed"; status: number | null; error: string };

export async function replayAgainstPatch(
  sessionId: string,
  alertId: string,
): Promise<ReplayResultDto> {
  try {
    const raw = await invoke<RawReplayResult>("replay_against_patch", {
      args: { session_id: sessionId, alert_id: alertId },
    });
    return mapReplayResult(raw);
  } catch (e) {
    return {
      kind: "request_failed",
      status: null,
      error: e instanceof Error ? e.message : "replay invocation failed",
    };
  }
}

// Internal: shape backend ships over the wire (snake_case + tagged
// `kind`). Mapped to the camelCase TS shape the dock consumes.
type RawReplayResult =
  | {
      kind: "ok";
      throw_reproduced: boolean;
      throws_after: number;
      runner_mode: string | null;
      fix_branch: string | null;
      duration_ms: number | null;
      head_throw: {
        exception_name: string;
        exception_message: string;
        top_frame_function: string | null;
        top_frame_file: string | null;
        top_frame_line: number | null;
      } | null;
    }
  | { kind: "no_recording"; receipt_id: string }
  | { kind: "no_receipt" }
  | { kind: "config_missing"; reason: string }
  | { kind: "request_failed"; status: number | null; error: string };

function mapReplayResult(raw: RawReplayResult): ReplayResultDto {
  switch (raw.kind) {
    case "ok":
      return {
        kind: "ok",
        throwReproduced: raw.throw_reproduced,
        throwsAfter: raw.throws_after,
        runnerMode: raw.runner_mode,
        fixBranch: raw.fix_branch,
        durationMs: raw.duration_ms,
        headThrow: raw.head_throw
          ? {
              exceptionName: raw.head_throw.exception_name,
              exceptionMessage: raw.head_throw.exception_message,
              topFrameFunction: raw.head_throw.top_frame_function,
              topFrameFile: raw.head_throw.top_frame_file,
              topFrameLine: raw.head_throw.top_frame_line,
            }
          : null,
      };
    case "no_recording":
      return { kind: "no_recording", receiptId: raw.receipt_id };
    case "no_receipt":
      return { kind: "no_receipt" };
    case "config_missing":
      return { kind: "config_missing", reason: raw.reason };
    case "request_failed":
      return {
        kind: "request_failed",
        status: raw.status,
        error: raw.error,
      };
  }
}
