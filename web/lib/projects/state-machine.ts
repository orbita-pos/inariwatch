/**
 * Pure project-state machine — Inari Live V1 Session 3.
 *
 * Every transition rule lives here so the DB-aware helper in `state.ts`
 * stays small and the unit tests don't have to mock Drizzle. This file
 * MUST remain free of DB / Next / Audit imports — the test suite
 * relies on importing it without DATABASE_URL set.
 */

/**
 * The seven valid wizard states. Order is the canonical happy-path
 * progression — keep it that way so future readers can grep this list
 * and immediately see the funnel.
 *
 * Stays in sync with the `projects_state_chk` CHECK constraint in
 * migration 0091. If you add/remove a value here, update the migration
 * AND ship a follow-up that runs `ALTER TABLE projects DROP CONSTRAINT
 * projects_state_chk; ADD CONSTRAINT ... CHECK (...)` in a fresh file.
 */
export const PROJECT_STATES = [
  "created",
  "needs_setup",
  "setting_up",
  "prepared",
  "verified",
  "live",
  "archived",
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

/**
 * Every key is the FROM state; the array lists every valid TO state.
 * Anything not enumerated here is rejected — that's the contract.
 *
 * Notes on individual edges:
 *   * `archived` is a terminal state for the wizard's purposes; the
 *     "unarchive" UX is V1.5+ scope.
 *   * `live → archived` covers user-initiated project deletion via
 *     soft-delete (the wizard never archives, but the helper is shared
 *     across all transitions in S3+).
 *   * `verified → live` is the autodismiss after the wizard's success
 *     screen. The web SSE stream pushes `verified` to the wizard UI;
 *     once the wizard closes (user click "Done" or a 30s auto-timer),
 *     the actions.ts caller flips state to `live`.
 *   * Self-loops (e.g. `setting_up → setting_up`) are intentionally
 *     NOT allowed — those would mask wizard bugs where a step misfires
 *     twice. Callers should make their installs idempotent at the
 *     filesystem level instead of leaning on state replay.
 */
export const VALID_TRANSITIONS: Record<ProjectState, ProjectState[]> = {
  created:     ["needs_setup", "archived"],
  needs_setup: ["setting_up", "archived"],
  setting_up:  ["prepared", "needs_setup", "archived"],
  prepared:    ["verified", "needs_setup", "archived"],
  verified:    ["live", "archived"],
  live:        ["archived"],
  archived:    [],
};

export function isValidTransition(from: ProjectState, to: ProjectState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
