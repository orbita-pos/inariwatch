/**
 * First-event handling for the Add-Project wizard — Inari Live V1 S3.
 *
 * Two entry points the capture webhook calls:
 *
 *   1. `markWizardTestEventReceived(projectId)` — fired when the
 *      desktop wizard's verification ping arrives (POST tagged
 *      `_inariwatch_test: true`). We do NOT insert an alert row for
 *      these (filter-from-dashboard rule), but we DO transition state
 *      to `verified` if the project is mid-wizard, and broadcast a
 *      `project.first_event_arrived` so the SSE stream pushes it to
 *      the wizard UI.
 *
 *   2. `maybeMarkFirstRealEvent(projectId)` — fired AFTER a real alert
 *      gets persisted via createAlertIfNew. Same effect: transition to
 *      verified + broadcast. Lets the wizard close the loop even when
 *      a genuine prod error beats the synthetic test ping (a real
 *      possibility on noisy services).
 *
 * Both paths short-circuit when the project's state isn't one of the
 * wizard-active values, so post-verify alerts don't replay the
 * transition. The state.ts helper's optimistic lock makes the check +
 * transition race-safe even under concurrent webhooks.
 */

import { ProjectStateError, getProjectState, transitionState } from "./state";
import { publishProjectEvent } from "./event-bus";

/** States in which a "first event" should advance the wizard. */
const WIZARD_ACTIVE_STATES = new Set(["needs_setup", "setting_up", "prepared"]);

export interface FirstEventOutcome {
  /** True only when this call actually advanced the project state. */
  transitioned: boolean;
  /** True when the project was already past the wizard (live, archived, etc). */
  alreadyDone: boolean;
}

/**
 * Wizard test ping path. Always fires the broadcast (even when state
 * is already past `verified`) so the wizard UI dismisses cleanly. The
 * state transition only happens when eligible.
 */
export async function markWizardTestEventReceived(
  projectId: string,
  alertIdForBroadcast: string,
): Promise<FirstEventOutcome> {
  const state = await getProjectState(projectId);
  if (!state) return { transitioned: false, alreadyDone: false };

  // Always broadcast — desktop wizards listen for this regardless of
  // server-side state to know "ingest pipeline is alive".
  publishProjectEvent(projectId, {
    type:    "project.first_event_arrived",
    alertId: alertIdForBroadcast,
    at:      new Date().toISOString(),
  });

  if (!WIZARD_ACTIVE_STATES.has(state)) {
    return { transitioned: false, alreadyDone: true };
  }
  try {
    await transitionState({
      projectId,
      from: state as "needs_setup" | "setting_up" | "prepared",
      to:   "verified",
      metadata: { source: "wizard_test_event" },
    });
    return { transitioned: true, alreadyDone: false };
  } catch (err) {
    // Concurrent transition — another path got here first. Not an
    // error from the caller's perspective; the verified broadcast
    // already went out.
    if (err instanceof ProjectStateError && err.code === "stale_from_state") {
      return { transitioned: false, alreadyDone: true };
    }
    throw err;
  }
}

/**
 * Real-event path. Same effect as the test path but skips the
 * broadcast when the project isn't wizard-active — there's no UI
 * subscriber to notify and we don't want to spam the bus on every
 * alert during steady state.
 */
export async function maybeMarkFirstRealEvent(
  projectId: string,
  alertId: string,
): Promise<FirstEventOutcome> {
  const state = await getProjectState(projectId);
  if (!state) return { transitioned: false, alreadyDone: false };
  if (!WIZARD_ACTIVE_STATES.has(state)) {
    return { transitioned: false, alreadyDone: true };
  }
  try {
    await transitionState({
      projectId,
      from: state as "needs_setup" | "setting_up" | "prepared",
      to:   "verified",
      metadata: { source: "first_real_event", alertId },
    });
    publishProjectEvent(projectId, {
      type:    "project.first_event_arrived",
      alertId,
      at:      new Date().toISOString(),
    });
    return { transitioned: true, alreadyDone: false };
  } catch (err) {
    if (err instanceof ProjectStateError && err.code === "stale_from_state") {
      return { transitioned: false, alreadyDone: true };
    }
    throw err;
  }
}

/**
 * Quick boolean sniff for the test-event marker. Centralised so the
 * capture webhook + future SDK paths share one definition.
 */
export function isWizardTestEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return e._inariwatch_test === true;
}
