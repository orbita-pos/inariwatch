/**
 * Tests for the shared rollbackAlertDeploy / rollbackProjectDeploy services
 * that back the dashboard, Slack /rollback command, and MCP rollback_deploy
 * tool. Mocks db, findHostingProvider, and getRollbackProvider so tests run
 * without a real DB connection.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockFindHostingProvider = vi.fn();
const mockGetRollbackProvider = vi.fn();
const mockLogAudit = vi.fn().mockResolvedValue(undefined);

// Sentinel for the update chain so we can assert isResolved was set.
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/lib/db", () => ({
  db: {
    select: mockSelect,
    update: () => updateChain,
  },
  alerts: { id: "alerts.id", isResolved: "alerts.isResolved", isRead: "alerts.isRead" },
  projects: { id: "projects.id", userId: "projects.userId" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ __inArray: [a, b] }),
  sql: (strings: unknown) => strings,
}));

vi.mock("@/lib/services/auto-rollback", () => ({
  findHostingProvider: mockFindHostingProvider,
}));

vi.mock("@/lib/providers/rollback", () => ({
  getRollbackProvider: mockGetRollbackProvider,
  UnsupportedProviderError: class UnsupportedProviderError extends Error {
    constructor(public readonly service: string, message?: string) {
      super(message ?? `not supported: ${service}`);
      this.name = "UnsupportedProviderError";
    }
  },
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
}));

// Import AFTER mocks are set
const { rollbackAlertDeploy, rollbackProjectDeploy } = await import("../alert-rollback");
const { UnsupportedProviderError } = await import("@/lib/providers/rollback");

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeSelectChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

function makeProvider(overrides: {
  lastGood?: { id: string; url: string; state: "ready"; createdAt: number } | null;
  rollback?: { deploymentId: string; url: string };
  rollbackError?: Error;
}) {
  const lastGoodValue = "lastGood" in overrides
    ? overrides.lastGood
    : { id: "dep-good", url: "https://example.netlify.app", state: "ready" as const, createdAt: 0 };
  return {
    service: "netlify",
    getLastSuccessfulDeploy: vi.fn().mockResolvedValue(lastGoodValue),
    rollbackToDeployment: overrides.rollbackError
      ? vi.fn().mockRejectedValue(overrides.rollbackError)
      : vi.fn().mockResolvedValue(
          overrides.rollback ?? { deploymentId: "dep-good", url: "https://example.netlify.app" },
        ),
    getBuildLogs: vi.fn().mockResolvedValue(null),
    checkPermissions: vi.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateChain.set.mockClear().mockReturnThis();
  updateChain.where.mockClear().mockResolvedValue(undefined);
});

// ── rollbackAlertDeploy ────────────────────────────────────────────────────

describe("rollbackAlertDeploy — happy path", () => {
  it("loads alert, finds provider, rolls back, resolves alert", async () => {
    // 1st select = load alert; 2nd select = ownership check
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));

    mockFindHostingProvider.mockResolvedValue({
      service: "netlify",
      token: "nfp_abc",
      siteId: "site-1",
      projectName: "my-site",
    });

    const provider = makeProvider({});
    mockGetRollbackProvider.mockReturnValue(provider);

    const result = await rollbackAlertDeploy({
      alertId: "alert-1",
      userId: "user-1",
      source: "dashboard",
    });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe("netlify");
    expect(result.deploymentId).toBe("dep-good");
    expect(result.url).toBe("https://example.netlify.app");
    expect(provider.getLastSuccessfulDeploy).toHaveBeenCalled();
    expect(provider.rollbackToDeployment).toHaveBeenCalledWith("dep-good");
    // Alert should be marked resolved
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ isResolved: true, isRead: true }),
    );
    // Audit logged
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert.rollback" }),
    );
  });
});

describe("rollbackAlertDeploy — error paths", () => {
  it("returns error when alert not found", async () => {
    mockSelect.mockReturnValueOnce(fakeSelectChain([]));
    const result = await rollbackAlertDeploy({ alertId: "missing" });
    expect(result.error).toMatch(/Alert not found/);
  });

  it("returns generic 'not found' when ownership check fails (no enumeration)", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([])); // no project row for this user
    const result = await rollbackAlertDeploy({ alertId: "alert-1", userId: "wrong-user" });
    // Same string as "alert not found" so callers can't distinguish.
    expect(result.error).toBe("Alert not found.");
  });

  it("returns error when no hosting provider connected", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));
    mockFindHostingProvider.mockResolvedValue(null);

    const result = await rollbackAlertDeploy({ alertId: "alert-1", userId: "user-1" });
    expect(result.error).toMatch(/No hosting integration connected/);
  });

  it("returns error when no last successful deploy", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));
    mockFindHostingProvider.mockResolvedValue({
      service: "netlify",
      token: "x",
      siteId: "s",
      projectName: "p",
    });
    mockGetRollbackProvider.mockReturnValue(makeProvider({ lastGood: null }));

    const result = await rollbackAlertDeploy({ alertId: "alert-1", userId: "user-1" });
    expect(result.error).toMatch(/No previous successful deployment/);
  });

  it("returns error when rollback call throws", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));
    mockFindHostingProvider.mockResolvedValue({
      service: "netlify",
      token: "x",
      siteId: "s",
      projectName: "p",
    });
    mockGetRollbackProvider.mockReturnValue(
      makeProvider({ rollbackError: new Error("API 500") }),
    );

    const result = await rollbackAlertDeploy({ alertId: "alert-1", userId: "user-1" });
    expect(result.error).toBe("API 500");
  });

  it("returns specific error when provider is unsupported (stub)", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));
    mockFindHostingProvider.mockResolvedValue({
      service: "railway",
      token: "x",
      projectName: "p",
    });
    mockGetRollbackProvider.mockReturnValue(
      makeProvider({
        rollbackError: new UnsupportedProviderError("railway"),
      }),
    );

    const result = await rollbackAlertDeploy({ alertId: "alert-1", userId: "user-1" });
    expect(result.error).toMatch(/railway.*not yet implemented/);
  });

  it("does NOT resolve alert when resolveOnSuccess=false", async () => {
    mockSelect
      .mockReturnValueOnce(fakeSelectChain([{ id: "alert-1", projectId: "proj-1" }]))
      .mockReturnValueOnce(fakeSelectChain([{ id: "proj-1", userId: "user-1" }]));
    mockFindHostingProvider.mockResolvedValue({
      service: "netlify",
      token: "x",
      siteId: "s",
      projectName: "p",
    });
    mockGetRollbackProvider.mockReturnValue(makeProvider({}));

    await rollbackAlertDeploy({
      alertId: "alert-1",
      userId: "user-1",
      resolveOnSuccess: false,
    });

    expect(updateChain.set).not.toHaveBeenCalled();
  });
});

// ── rollbackProjectDeploy ──────────────────────────────────────────────────

describe("rollbackProjectDeploy", () => {
  it("rolls back without loading an alert", async () => {
    mockSelect.mockReturnValueOnce(
      fakeSelectChain([{ id: "proj-1", userId: "user-1" }]),
    );
    mockFindHostingProvider.mockResolvedValue({
      service: "render",
      token: "rnd",
      serviceId: "srv-1",
      projectName: "my-api",
    });
    const provider = makeProvider({});
    mockGetRollbackProvider.mockReturnValue(provider);

    const result = await rollbackProjectDeploy({
      projectId: "proj-1",
      userId: "user-1",
      source: "slack",
    });

    expect(result.error).toBeUndefined();
    expect(result.provider).toBe("render");
    expect(result.deploymentId).toBe("dep-good");
    // No alert update should happen in project mode
    expect(updateChain.set).not.toHaveBeenCalled();
    // Audit should be logged with project.rollback
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "project.rollback" }),
    );
  });

  it("returns generic 'not found' when userId doesn't own project (no enumeration)", async () => {
    mockSelect.mockReturnValueOnce(fakeSelectChain([]));
    const result = await rollbackProjectDeploy({
      projectId: "proj-1",
      userId: "wrong-user",
    });
    // Same string as "project not found" so callers can't distinguish.
    expect(result.error).toBe("Project not found.");
  });

  it("returns error when no hosting provider", async () => {
    // No ownership check when userId is not passed
    mockFindHostingProvider.mockResolvedValue(null);
    const result = await rollbackProjectDeploy({ projectId: "proj-1" });
    expect(result.error).toMatch(/No hosting integration connected/);
  });
});
