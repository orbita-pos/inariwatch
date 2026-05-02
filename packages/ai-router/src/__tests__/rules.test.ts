import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks";
import { RULES, getRule, resolvePrimary } from "../rules";

describe("routing rules — Phase 1", () => {
  it("routes every task to cloud", () => {
    for (const [task, rule] of Object.entries(RULES)) {
      expect(rule.primary.substrate, `task ${task} primary`).toBe("cloud");
    }
  });

  it("getRule returns the configured rule for each task", () => {
    const r = getRule(TASKS.CODE_FIX_SINGLE_SHOT);
    expect(r.primary.substrate).toBe("cloud");
    expect(r.fallback?.substrate).toBe("cloud");
  });

  it("resolvePrimary respects forceCloudOnly", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      forceCloudOnly: true,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("resolvePrimary applies workspace task overrides", () => {
    const r = resolvePrimary(TASKS.CODE_FIX_SINGLE_SHOT, {
      taskOverrides: {
        [TASKS.CODE_FIX_SINGLE_SHOT]: {
          substrate: "cloud",
          provider: "claude",
          model: "claude-sonnet-4-6",
        },
      },
    });
    expect(r.substrate).toBe("cloud");
    if (r.substrate === "cloud") {
      expect(r.provider).toBe("claude");
      expect(r.model).toBe("claude-sonnet-4-6");
    }
  });
});
