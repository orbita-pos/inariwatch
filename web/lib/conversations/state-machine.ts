/**
 * Pure conversation-state machine — Inari Live V1 Session 5.
 *
 * Mirrors the project state-machine pattern from S3: every transition
 * rule lives here so the DB-aware service stays small and unit tests
 * don't have to mock Drizzle. This file MUST stay free of DB / Next /
 * audit imports — chain verify, snooze sweeper, and slash dispatch all
 * import it and would otherwise pull DATABASE_URL into surfaces that
 * shouldn't need it.
 */

/**
 * The four conversation states. Order is the canonical happy-path
 * progression for an alert-anchored thread (active is also where free
 * chats start).
 *
 * Stays in sync with the `conversations_state_chk` CHECK constraint in
 * migration 0092. If you add/remove a value here, ship a follow-up
 * migration that swaps the constraint.
 */
export const CONVERSATION_STATES = [
  "active",
  "snoozed",
  "resolved",
  "archived",
] as const;

export type ConversationState = (typeof CONVERSATION_STATES)[number];

/**
 * Every key is the FROM state; the array lists every valid TO state.
 * Anything not enumerated here is rejected — that's the contract.
 *
 * Notes on individual edges:
 *   * `archived` is terminal — un-archive is V1.5+ scope.
 *   * `resolved → active` is the "reopen" edge, surfaced via `/reopen`
 *     slash command + the right-panel button in Mode C.
 *   * `snoozed → active` is the wake-up edge, fired by either the
 *     snooze-sweeper cron OR a manual "Wake now" click.
 *   * `active → archived` is direct (skip resolved) when the user just
 *     wants to silence a noisy thread without claiming it was fixed.
 *   * Self-loops are NOT allowed — every mutation that doesn't change
 *     state goes through `postMessage` instead, not `setState`.
 */
export const VALID_TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  active:   ["snoozed", "resolved", "archived"],
  snoozed:  ["active", "resolved", "archived"],
  resolved: ["active", "archived"],
  archived: [],
};

export function isValidConversationTransition(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Type-guard for runtime payloads coming from API bodies / WS frames.
 * Returns `null` when the value isn't a known state — caller decides
 * how loud to be (4xx vs silent ignore).
 */
export function asConversationState(value: unknown): ConversationState | null {
  if (typeof value !== "string") return null;
  return (CONVERSATION_STATES as readonly string[]).includes(value)
    ? (value as ConversationState)
    : null;
}
