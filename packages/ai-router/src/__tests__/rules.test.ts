import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks";
import { RULES, getRule, resolvePrimary } from "../rules";

describe("routing rules — S3 (post-flip)", () => {
  it("only flag-gated rules may target a non-cloud substrate", () => {
    // After S3 the invariant becomes: a non-cloud primary REQUIRES both
    // a workspaceFlag (so it stays opt-in) AND a fallback (so the
    // workspace stays on cloud when the flag is off / sidecar drops).
    // Adding a new local-routed task without those breaks zero-regression
    // for existing customers.
    for (const [task, rule] of Object.entries(RULES)) {
      if (rule.primary.substrate === "cloud") continue;
      expect(
        rule.workspaceFlag,
        `task ${task} routes to ${rule.primary.substrate} but has no workspaceFlag — would change behavior for every workspace`,
      ).toBeTruthy();
      expect(
        rule.fallback,
        `task ${task} routes to ${rule.primary.substrate} but has no fallback — sidecar offline would throw`,
      ).toBeTruthy();
    }
  });

  it("notify.compose.email is the first user-sidecar rule and lands behind localNotifyEnabled", () => {
    const r = getRule(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(r.primary.substrate).toBe("user-sidecar");
    expect(r.workspaceFlag).toBe("localNotifyEnabled");
    expect(r.fallback?.substrate).toBe("cloud");
    expect(r.fallbackTriggers).toContain("sidecar-offline");
    expect(r.fallbackTriggers).toContain("sidecar-timeout");
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

  // S3 zero-regression invariant: workspaces with the flag OFF must
  // resolve to the same target the pre-S3 rule pointed at (cloud). If
  // this fails, a customer who never opts in starts seeing local-routed
  // dispatches — that's the regression the wedge has to avoid.
  it("notify.compose.email resolves to cloud when localNotifyEnabled is undefined", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL);
    expect(r.substrate).toBe("cloud");
  });

  it("notify.compose.email resolves to cloud when localNotifyEnabled is false", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: false,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("notify.compose.email resolves to user-sidecar when localNotifyEnabled is true", () => {
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: true,
    });
    expect(r.substrate).toBe("user-sidecar");
    if (r.substrate === "user-sidecar") {
      expect(r.model).toBe("qwen2.5-coder-1.5b");
    }
  });

  it("forceCloudOnly wins over localNotifyEnabled=true", () => {
    // §6.3 — workspace can opt out even if the per-task flag is on.
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      localNotifyEnabled: true,
      forceCloudOnly: true,
    });
    expect(r.substrate).toBe("cloud");
  });

  it("taskOverrides win over both forceCloudOnly and localNotifyEnabled", () => {
    // Admin escape hatch — the override wins outright. Tests just that
    // the precedence order is correct, not that any user-facing toggle
    // surfaces it.
    const r = resolvePrimary(TASKS.NOTIFY_COMPOSE_EMAIL, {
      forceCloudOnly: true,
      localNotifyEnabled: false,
      taskOverrides: {
        [TASKS.NOTIFY_COMPOSE_EMAIL]: {
          substrate: "user-sidecar",
          model: "qwen2.5-coder-1.5b",
        },
      },
    });
    expect(r.substrate).toBe("user-sidecar");
  });

  // v0.3 S4 — slack / telegram / push joined the local-routing set
  // behind the SAME workspace flag. Same proofs as email: cloud when
  // off, user-sidecar when on, fallback contract preserved.
  it.each([
    TASKS.NOTIFY_COMPOSE_SLACK,
    TASKS.NOTIFY_COMPOSE_TELEGRAM,
    TASKS.NOTIFY_COMPOSE_PUSH,
  ] as const)(
    "%s routes to user-sidecar when localNotifyEnabled=true (S4)",
    (task) => {
      const r = resolvePrimary(task, { localNotifyEnabled: true });
      expect(r.substrate).toBe("user-sidecar");
      if (r.substrate === "user-sidecar") {
        expect(r.model).toBe("qwen2.5-coder-1.5b");
      }
    },
  );

  it.each([
    TASKS.NOTIFY_COMPOSE_SLACK,
    TASKS.NOTIFY_COMPOSE_TELEGRAM,
    TASKS.NOTIFY_COMPOSE_PUSH,
  ] as const)(
    "%s falls back to cloud when localNotifyEnabled is undefined (S4)",
    (task) => {
      // S4 zero-regression invariant — same as the S3 email check. A
      // workspace that never flips the toggle keeps seeing cloud
      // dispatches for slack/telegram/push.
      const r = resolvePrimary(task);
      expect(r.substrate).toBe("cloud");
    },
  );

  it.each([
    TASKS.NOTIFY_COMPOSE_SLACK,
    TASKS.NOTIFY_COMPOSE_TELEGRAM,
    TASKS.NOTIFY_COMPOSE_PUSH,
  ] as const)("%s declares fallback + triggers like email (S4)", (task) => {
    const r = getRule(task);
    expect(r.workspaceFlag).toBe("localNotifyEnabled");
    expect(r.fallback?.substrate).toBe("cloud");
    expect(r.fallbackTriggers).toContain("sidecar-offline");
    expect(r.fallbackTriggers).toContain("sidecar-timeout");
    expect(r.fallbackTriggers).toContain("workspace-flag-cloud-only");
  });

  it("forceCloudOnly wins over localNotifyEnabled for S4 channels too", () => {
    for (const task of [
      TASKS.NOTIFY_COMPOSE_SLACK,
      TASKS.NOTIFY_COMPOSE_TELEGRAM,
      TASKS.NOTIFY_COMPOSE_PUSH,
    ]) {
      const r = resolvePrimary(task, {
        localNotifyEnabled: true,
        forceCloudOnly: true,
      });
      expect(r.substrate, `task ${task}`).toBe("cloud");
    }
  });

  // Remaining notify.* tasks stay cloud until S5+ wires their surfaces.
  it("notify.compose.{whatsapp,digest,status-page,postmortem-prose} remain cloud after S4", () => {
    for (const task of [
      TASKS.NOTIFY_COMPOSE_WHATSAPP,
      TASKS.NOTIFY_COMPOSE_DIGEST,
      TASKS.NOTIFY_COMPOSE_STATUS_PAGE,
      TASKS.NOTIFY_COMPOSE_POSTMORTEM_PROSE,
    ]) {
      const r = resolvePrimary(task, { localNotifyEnabled: true });
      expect(r.substrate, `task ${task}`).toBe("cloud");
    }
  });
});
