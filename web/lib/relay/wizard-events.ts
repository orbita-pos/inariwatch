/**
 * Wizard event emitter — Inari Live V1 Session 3.
 *
 * Web → desktop bridge for the Add-Project wizard. When a user clicks
 * "Add Project" on /dashboard/projects/new, web's server action mints
 * the project row, transitions to `needs_setup`, then asks the relay
 * to deliver a `project.wizard.open` task to the user's connected
 * Inari Live install.
 *
 * Why piggyback on the relay's `/dispatch` endpoint instead of building
 * a new fanout channel:
 *   * The relay already routes by user_id, holds the WS to the
 *     desktop, and handles offline/timeout gracefully — that's exactly
 *     what we need.
 *   * Adding a new task name (`project.wizard.open`) is a single arm
 *     in `relay_client.rs::handle_dispatch_full` on the desktop side.
 *   * If the user is offline, the relay returns 503 / sidecar-offline.
 *     Web ALSO transitions state to `needs_setup` regardless, so the
 *     dashboard renders an "Open in Inari Live" CTA the user can click
 *     once their desktop is back online — closing the loop without an
 *     event delivery guarantee. (Persistent queue is V1.5+ scope.)
 *
 * The dispatch is intentionally fire-and-forget from the web's caller
 * perspective — emitWizardOpen returns the relay's status string
 * (`delivered` / `sidecar-offline` / etc) for telemetry but never
 * throws. State transitions and audit logs still happen even on
 * delivery failure.
 */

import {
  RelayError,
  dispatchToRelay,
  readRelayConfigFromEnv,
} from "@inariwatch/ai-router";

/** Task name the relay routes; matches the desktop dispatcher arm. */
const TASK = "project.wizard.open";

/** Server-to-server dispatch SLO from INARI_AI_ARCHITECTURE.md §4.3. */
const DISPATCH_TIMEOUT_MS = 5_000;

export interface WizardOpenPayload {
  projectId:    string;
  projectSlug:  string;
  /** `owner/repo` form. Desktop scans `~/code` etc. for a clone matching this. */
  repoFullName: string;
  framework:    "next" | "express" | "vite" | "node" | null;
  host:         "vercel" | null;
  createdAt:    string;
}

export type WizardEmitOutcome =
  | { ok: true; deliveredAt: string }
  | { ok: false; reason: WizardEmitFailure };

export type WizardEmitFailure =
  | "config-missing"
  | "sidecar-offline"
  | "sidecar-timeout"
  | "sidecar-disconnect"
  | "relay-unreachable"
  | "relay-auth-failed"
  | "bad-response"
  | "unknown";

/**
 * Best-effort dispatch a `project.wizard.open` task to the user's
 * Inari Live sidecar. Never throws — telemetry caller decides what to
 * do with the failure (typically: log + show "Open in Inari Live"
 * CTA).
 */
export async function emitWizardOpen(
  userId: string,
  payload: WizardOpenPayload,
): Promise<WizardEmitOutcome> {
  const cfg = readRelayConfigFromEnv();
  if (!cfg) {
    return { ok: false, reason: "config-missing" };
  }

  try {
    const res = await dispatchToRelay(cfg, {
      userId,
      task: TASK,
      payload: payload as unknown as Record<string, unknown>,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    if (res.status === "ok") {
      return { ok: true, deliveredAt: new Date().toISOString() };
    }
    return { ok: false, reason: mapErrorString(res.error) };
  } catch (err) {
    if (err instanceof RelayError) {
      return { ok: false, reason: err.code };
    }
    return { ok: false, reason: "unknown" };
  }
}

function mapErrorString(err?: string): WizardEmitFailure {
  if (!err) return "unknown";
  if (err.includes("sidecar-offline")) return "sidecar-offline";
  if (err.includes("sidecar-timeout")) return "sidecar-timeout";
  if (err.includes("sidecar-disconnect")) return "sidecar-disconnect";
  return "unknown";
}

/** Test-only: surface the task constant so tests don't drift. */
export const __WIZARD_OPEN_TASK_FOR_TESTS = TASK;
