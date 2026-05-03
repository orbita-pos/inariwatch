/**
 * Phase 3.2 — container-agent A/B router.
 *
 * Tests the engine resolution + sticky-per-session dice + kill switch
 * + per-workspace pct override. The DB lookup is exercised via the
 * `workspaceLookup` injection seam — production wiring uses the default
 * which queries Neon.
 *
 * Vitest as runner (same posture as Phase 1.6's code-intel-tools.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  db: {},
  organizations: {},
  projects: {},
  remediationSessions: {},
  codeIntelRemediationAb: {},
}));

import {
  isAgentAbKilled,
  resolveAgentEngine,
  resolveGlobalAgentAbPct,
  stickyDice,
  type AgentEngineDecision,
} from "../tools/code-intel-ab.js";

const ENV_KEYS = ["CONTAINER_AGENT_AB_PCT", "CONTAINER_AGENT_AB_KILL_V2"] as const;
const SAVED: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) SAVED[k] = process.env[k];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

// ── Env / kill switch ──────────────────────────────────────────────────────

describe("isAgentAbKilled", () => {
  it("default off when env unset", () => {
    expect(isAgentAbKilled()).toBe(false);
  });

  it("accepts truthy spellings", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "  on  "]) {
      process.env.CONTAINER_AGENT_AB_KILL_V2 = v;
      expect(isAgentAbKilled()).toBe(true);
    }
  });

  it("rejects anything else (typo protection)", () => {
    for (const v of ["0", "false", "off", "no", "shadow", ""]) {
      process.env.CONTAINER_AGENT_AB_KILL_V2 = v;
      expect(isAgentAbKilled()).toBe(false);
    }
  });
});

describe("resolveGlobalAgentAbPct", () => {
  it("default 0 (= all v1) when env unset", () => {
    expect(resolveGlobalAgentAbPct()).toBe(0);
  });

  it("returns env value rounded to integer", () => {
    process.env.CONTAINER_AGENT_AB_PCT = "50";
    expect(resolveGlobalAgentAbPct()).toBe(50);
    process.env.CONTAINER_AGENT_AB_PCT = "27.4";
    expect(resolveGlobalAgentAbPct()).toBe(27);
    process.env.CONTAINER_AGENT_AB_PCT = "27.6";
    expect(resolveGlobalAgentAbPct()).toBe(28);
  });

  it("clamps out-of-range values", () => {
    process.env.CONTAINER_AGENT_AB_PCT = "-5";
    expect(resolveGlobalAgentAbPct()).toBe(0);
    process.env.CONTAINER_AGENT_AB_PCT = "150";
    expect(resolveGlobalAgentAbPct()).toBe(100);
  });

  it("falls back to 0 for non-numeric (typo protection)", () => {
    process.env.CONTAINER_AGENT_AB_PCT = "fifty";
    expect(resolveGlobalAgentAbPct()).toBe(0);
  });
});

// ── Sticky dice ────────────────────────────────────────────────────────────

describe("stickyDice", () => {
  it("returns the same value for the same input", () => {
    const a = stickyDice("session-abc-123");
    const b = stickyDice("session-abc-123");
    expect(a).toBe(b);
  });

  it("returns a value in [0, 100)", () => {
    for (let i = 0; i < 100; i++) {
      const v = stickyDice(`session-${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(100);
    }
  });

  it("distributes roughly uniformly across 1000 ids (each bucket > 0)", () => {
    // We don't need a tight chi-square; FNV-1a is a known good distributor.
    // The point of this test is to catch accidental degenerate hashes
    // (e.g. always 0 because of a typo).
    const buckets = new Map<number, number>();
    for (let i = 0; i < 1000; i++) {
      const v = stickyDice(`s-${i}-${Math.random()}`);
      const bucket = Math.floor(v / 10); // 10 buckets of 10
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    // Every bucket must be hit at least once.
    expect(buckets.size).toBe(10);
  });
});

// ── Engine decision ────────────────────────────────────────────────────────

const stubLookup = (pct: number | null) => async () => pct;

describe("resolveAgentEngine — kill switch", () => {
  it("forces v1 regardless of pct, projectId, sessionId", async () => {
    process.env.CONTAINER_AGENT_AB_KILL_V2 = "1";
    process.env.CONTAINER_AGENT_AB_PCT = "100";

    const decision = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(100),
    });

    expect(decision.engine).toBe("v1");
    expect(decision.source).toBe("kill");
    expect(decision.workspacePct).toBeNull();
  });
});

describe("resolveAgentEngine — pct boundaries", () => {
  it("workspacePct=0 → v1 (no dice roll needed)", async () => {
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(0),
    });
    expect(d.engine).toBe("v1");
    expect(d.source).toBe("workspace");
    expect(d.workspacePct).toBe(0);
  });

  it("workspacePct=100 → v2 (no dice roll needed)", async () => {
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(100),
    });
    expect(d.engine).toBe("v2");
    expect(d.source).toBe("workspace");
    expect(d.workspacePct).toBe(100);
  });

  it("pct=0, no override → source='default'", async () => {
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(null),
    });
    expect(d.engine).toBe("v1");
    expect(d.source).toBe("default");
  });

  it("global env=100 (no workspace) → v2 from source='global'", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "100";
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(null),
    });
    expect(d.engine).toBe("v2");
    expect(d.source).toBe("global");
  });
});

describe("resolveAgentEngine — workspace beats env", () => {
  it("workspacePct=0 with env=100 still returns v1", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "100";
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(0),
    });
    expect(d.engine).toBe("v1");
    expect(d.source).toBe("workspace");
  });

  it("workspacePct=100 with env=0 still returns v2", async () => {
    const d = await resolveAgentEngine({
      sessionId: "any",
      projectId: "p1",
      workspaceLookup: stubLookup(100),
    });
    expect(d.engine).toBe("v2");
    expect(d.source).toBe("workspace");
  });
});

describe("resolveAgentEngine — sticky per session", () => {
  it("the same sessionId always returns the same engine", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "50";
    const d1 = await resolveAgentEngine({
      sessionId: "session-xyz",
      projectId: "p1",
      workspaceLookup: stubLookup(null),
    });
    const d2 = await resolveAgentEngine({
      sessionId: "session-xyz",
      projectId: "p1",
      workspaceLookup: stubLookup(null),
    });
    const d3 = await resolveAgentEngine({
      sessionId: "session-xyz",
      projectId: "p1",
      workspaceLookup: stubLookup(null),
    });
    expect(d1.engine).toBe(d2.engine);
    expect(d2.engine).toBe(d3.engine);
  });

  it("different sessionIds may pick different engines (otherwise the dice are degenerate)", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "50";
    const engines = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const d = await resolveAgentEngine({
        sessionId: `session-${i}`,
        projectId: "p1",
        workspaceLookup: stubLookup(null),
      });
      engines.add(d.engine);
    }
    // Both engines must show up at 50% across 100 sessions.
    expect(engines.has("v1")).toBe(true);
    expect(engines.has("v2")).toBe(true);
  });
});

describe("resolveAgentEngine — distribution at 50/50", () => {
  it("over 1000 sessions the v2 share lands in [0.4, 0.6]", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "50";
    let v2Count = 0;
    for (let i = 0; i < 1000; i++) {
      const d = await resolveAgentEngine({
        sessionId: `dist-session-${i}`,
        projectId: "p1",
        workspaceLookup: stubLookup(null),
      });
      if (d.engine === "v2") v2Count++;
    }
    expect(v2Count / 1000).toBeGreaterThanOrEqual(0.4);
    expect(v2Count / 1000).toBeLessThanOrEqual(0.6);
  });
});

describe("resolveAgentEngine — robust to missing data", () => {
  it("null projectId → falls back to global env", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "100";
    const d = await resolveAgentEngine({
      sessionId: "s1",
      projectId: null,
      // The default lookup returns null for null projectId.
    });
    expect(d.engine).toBe("v2");
    expect(d.source).toBe("global");
    expect(d.workspacePct).toBeNull();
  });

  it("with the production safe-lookup wrapper the throw is swallowed", async () => {
    process.env.CONTAINER_AGENT_AB_PCT = "100";
    // Reproduce the production code path: `getWorkspaceAgentAbPct` catches
    // its own DB errors and returns null, so the resolver always gets a
    // valid number-or-null and never sees the underlying exception.
    const safeLookup = async (): Promise<number | null> => {
      try {
        throw new Error("Neon hiccup");
      } catch {
        return null;
      }
    };
    const d = await resolveAgentEngine({
      sessionId: "s1",
      projectId: "p1",
      workspaceLookup: safeLookup,
    });
    expect(d.engine).toBe("v2");
    expect(d.source).toBe("global");
  });
});
