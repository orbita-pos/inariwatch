/**
 * Pure-module tests for the conversation state machine.
 *
 * Mirrors `web/lib/projects/__tests__/state-machine.test.ts` shape
 * (S3 pattern). Runs without `DATABASE_URL` because the module under
 * test has zero DB imports — the whole point of pulling state rules
 * into a separate file.
 */

import { describe, expect, test } from "vitest";

import {
  CONVERSATION_STATES,
  asConversationState,
  isValidConversationTransition,
  VALID_TRANSITIONS,
  type ConversationState,
} from "../state-machine";

describe("conversation state machine", () => {
  test("CONVERSATION_STATES contains the four canonical states", () => {
    expect([...CONVERSATION_STATES]).toEqual(["active", "snoozed", "resolved", "archived"]);
  });

  test("VALID_TRANSITIONS keys cover every state", () => {
    for (const s of CONVERSATION_STATES) {
      expect(VALID_TRANSITIONS).toHaveProperty(s);
    }
  });

  test("active → snoozed / resolved / archived are valid", () => {
    expect(isValidConversationTransition("active", "snoozed")).toBe(true);
    expect(isValidConversationTransition("active", "resolved")).toBe(true);
    expect(isValidConversationTransition("active", "archived")).toBe(true);
  });

  test("active → active (self-loop) is rejected", () => {
    expect(isValidConversationTransition("active", "active")).toBe(false);
  });

  test("snoozed wakes to active and can be resolved/archived", () => {
    expect(isValidConversationTransition("snoozed", "active")).toBe(true);
    expect(isValidConversationTransition("snoozed", "resolved")).toBe(true);
    expect(isValidConversationTransition("snoozed", "archived")).toBe(true);
    expect(isValidConversationTransition("snoozed", "snoozed")).toBe(false);
  });

  test("resolved can reopen (active) or archive", () => {
    expect(isValidConversationTransition("resolved", "active")).toBe(true);
    expect(isValidConversationTransition("resolved", "archived")).toBe(true);
    expect(isValidConversationTransition("resolved", "snoozed")).toBe(false);
  });

  test("archived is terminal", () => {
    for (const s of CONVERSATION_STATES) {
      expect(isValidConversationTransition("archived", s)).toBe(false);
    }
  });

  test("asConversationState recognises strings", () => {
    expect(asConversationState("active")).toBe("active");
    expect(asConversationState("snoozed")).toBe("snoozed");
    expect(asConversationState("resolved")).toBe("resolved");
    expect(asConversationState("archived")).toBe("archived");
  });

  test("asConversationState rejects unknowns", () => {
    expect(asConversationState("zombie")).toBeNull();
    expect(asConversationState("")).toBeNull();
    expect(asConversationState(null)).toBeNull();
    expect(asConversationState(42)).toBeNull();
    expect(asConversationState(undefined)).toBeNull();
  });

  test("type guard narrows correctly", () => {
    const v: unknown = "active";
    const narrowed = asConversationState(v);
    if (narrowed) {
      // Should compile-check as ConversationState — assignable to widening lookup.
      const _check: ConversationState = narrowed;
      expect(_check).toBe("active");
    } else {
      throw new Error("expected narrowing to succeed");
    }
  });
});
