import { describe, expect, it } from "vitest";
import { ALL_TASKS, TASKS, namespaceOf } from "../tasks";

describe("task taxonomy", () => {
  it("covers all 7 namespaces from architecture §5", () => {
    const namespaces = new Set(ALL_TASKS.map(namespaceOf));
    expect(namespaces).toEqual(
      new Set(["code", "alert", "notify", "voice", "chat", "redact", "gate"]),
    );
  });

  it("has exactly 30 tasks (architecture §5 quota)", () => {
    expect(ALL_TASKS.length).toBe(30);
  });

  it("encodes namespace as the first dot-segment", () => {
    expect(namespaceOf(TASKS.NOTIFY_COMPOSE_EMAIL)).toBe("notify");
    expect(namespaceOf(TASKS.CODE_FIX_AGENT_LOOP)).toBe("code");
    expect(namespaceOf(TASKS.GATE_PREDICTION)).toBe("gate");
  });

  it("all enum values follow `<domain>.<verb>.<specifier?>` format", () => {
    for (const t of ALL_TASKS) {
      expect(t).toMatch(/^[a-z]+\.[a-z-]+(\.[a-z-]+)?$/);
    }
  });
});
