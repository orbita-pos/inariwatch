/**
 * loadIntegrationByToken + isProjectTokenSecret tests
 * (Inari Live V1 — Session 2).
 *
 * Validates that the capture webhook auth resolver returns the correct
 * synthesized CaptureAuthSubject shape for token-mode requests, falls
 * through to null on garbage tokens, and surfaces the project owner's
 * plan so the daily event cap stays consistent across modes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const lookupSpy = vi.fn();

vi.mock("@/lib/services/project-tokens.service", () => ({
  loadProjectByToken: lookupSpy,
  TOKEN_PREFIX: "iwk_pub_v1_",
}));

vi.mock("@/lib/notifications/send", () => ({ enqueueAlert: vi.fn() }));
vi.mock("@/lib/webhooks/outgoing", () => ({ dispatchOutgoingWebhooks: vi.fn() }));
vi.mock("@/lib/ai/status-page-automation", () => ({ autoCreateIncident: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

// db.select(...).from(projects).innerJoin(users, ...).where(eq(projects.id, X)).limit(1)
const planRow = { plan: "pro" } as { plan: string } | undefined;
let nextPlanRow: typeof planRow = planRow;

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(nextPlanRow ? [nextPlanRow] : []),
          }),
        }),
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  },
  alerts: {},
  incidentStorms: {},
  projectIntegrations: {},
  projects: { id: "projects.id", userId: "projects.userId" },
  users: { id: "users.id", plan: "users.plan" },
  maintenanceWindows: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  and: (...preds: unknown[]) => ({ __and: preds }),
  gt: () => ({}),
  lte: () => ({}),
  gte: () => ({}),
  sql: () => ({}),
}));

const { loadIntegrationByToken, isProjectTokenSecret } = await import("../webhooks/shared");

beforeEach(() => {
  lookupSpy.mockReset();
  nextPlanRow = { plan: "pro" };
});

describe("isProjectTokenSecret", () => {
  it("recognises the iwk_pub_v1_ prefix", () => {
    expect(isProjectTokenSecret("iwk_pub_v1_xxx")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isProjectTokenSecret("nope")).toBe(false);
    expect(isProjectTokenSecret("")).toBe(false);
    expect(isProjectTokenSecret(null)).toBe(false);
    expect(isProjectTokenSecret(undefined)).toBe(false);
    expect(isProjectTokenSecret("iwk_pub_v2_xxx")).toBe(false);
  });
});

describe("loadIntegrationByToken", () => {
  it("returns null for a non-prefix string without consulting the DB", async () => {
    const out = await loadIntegrationByToken("not-a-token");
    expect(out).toBeNull();
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("returns null when the underlying token lookup misses (revoked / unknown)", async () => {
    lookupSpy.mockResolvedValueOnce(null);
    const out = await loadIntegrationByToken("iwk_pub_v1_xxx");
    expect(out).toBeNull();
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a synth CaptureAuthSubject shape for a live token", async () => {
    lookupSpy.mockResolvedValueOnce({
      tokenId:     "tok-1",
      projectId:   "proj-1",
      workspaceId: "ws-1",
      scope:       ["events:write"],
      rotatedTo:   null,
    });

    const out = await loadIntegrationByToken("iwk_pub_v1_xxx");
    expect(out).not.toBeNull();
    expect(out!.authMode).toBe("token");
    expect(out!.projectId).toBe("proj-1");
    expect(out!.workspaceId).toBe("ws-1");
    expect(out!.tokenId).toBe("tok-1");
    expect(out!.integrationId).toBeNull();
    expect(out!.webhookSecret).toBeNull();
    // Plan resolved from the project owner.
    expect(out!.userPlan).toBe("pro");
  });

  it("falls back to userPlan=null when the owner row is missing", async () => {
    lookupSpy.mockResolvedValueOnce({
      tokenId:     "tok-2",
      projectId:   "proj-2",
      workspaceId: null,
      scope:       ["events:write"],
      rotatedTo:   null,
    });
    nextPlanRow = undefined;

    const out = await loadIntegrationByToken("iwk_pub_v1_xxx");
    expect(out).not.toBeNull();
    expect(out!.userPlan).toBeNull();
    expect(out!.workspaceId).toBeNull();
  });
});
