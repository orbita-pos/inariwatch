/**
 * S6.5 — endpoint smoke tests for the two new /api/desktop/* routes
 * consumed by the desktop chat agent's cloud.* tools.
 *
 *   - /api/desktop/workspace-summary        → cloud.get_workspace_summary
 *   - /api/desktop/projects/[id]/health     → cloud.get_project_health
 *
 * Each test:
 *   - Mocks `lib/auth-extension` so the Bearer-token check is hermetic.
 *   - Mocks `lib/db` so visibility resolution doesn't hit the DB.
 *   - Mocks the service layer so we can assert the handler:
 *       (1) gates on Bearer auth (401 when missing),
 *       (2) resolves visibility correctly,
 *       (3) returns the service payload verbatim,
 *       (4) refuses to leak project ids the user can't see (404 for
 *           the health endpoint).
 *
 * Service-layer correctness (DB queries, on-call resolution, etc.) is
 * tested independently — these are thin route-shape checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth-extension", () => ({
  authenticateExtensionToken: vi.fn(),
  unauthorized: () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
}));

vi.mock("@/lib/db", () => ({
  db: {},
  projects: {},
  getUserOrganizations: vi.fn(),
  getWorkspaceProjectIds: vi.fn(),
}));

vi.mock("@/lib/services/desktop-widgets.service", () => ({
  getWorkspaceSummary: vi.fn(),
  getProjectHealth: vi.fn(),
}));

import { authenticateExtensionToken } from "@/lib/auth-extension";
import { getUserOrganizations, getWorkspaceProjectIds } from "@/lib/db";
import {
  getWorkspaceSummary,
  getProjectHealth,
} from "@/lib/services/desktop-widgets.service";
import { GET as workspaceSummaryGET } from "../workspace-summary/route";
import { GET as projectHealthGET } from "../projects/[id]/health/route";

const VISIBLE = ["p-personal-1", "p-org-1"];

function makeReq(url: string) {
  return new NextRequest(new URL(url), {
    headers: new Headers({ authorization: "Bearer test-token" }),
  });
}

function asAuthed() {
  (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    userId: "u-1",
    projectIds: [],
  });
  (getUserOrganizations as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "org-1", name: "Acme" },
  ]);
  (getWorkspaceProjectIds as unknown as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce(["p-personal-1"]) // personal call
    .mockResolvedValueOnce(["p-org-1"]); // org call
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/desktop/workspace-summary", () => {
  it("returns the aggregated summary across personal + org projects", async () => {
    asAuthed();
    const payload = {
      totalAlerts24h: 5,
      alertsCritical24h: 1,
      alertsWarning24h: 4,
      monitorsDown: 0,
      monitorsTotal: 2,
      projectCount: 2,
      topNoisyProject: { id: "p-personal-1", name: "Web", alerts24h: 3 },
      onCallSummary: null,
      lastAlertAt: "2026-05-14T10:00:00.000Z",
    };
    (getWorkspaceSummary as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      payload,
    );

    const res = await workspaceSummaryGET(
      makeReq("https://x/api/desktop/workspace-summary"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    // The service must see BOTH the personal + org-resolved project ids,
    // deduped — the same visibility envelope as `/api/desktop/projects`.
    const callArg = (getWorkspaceSummary as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string[];
    expect(callArg.sort()).toEqual([...VISIBLE].sort());
  });

  it("401s when the bearer fails", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    const res = await workspaceSummaryGET(
      makeReq("https://x/api/desktop/workspace-summary"),
    );
    expect(res.status).toBe(401);
    expect(getWorkspaceSummary).not.toHaveBeenCalled();
  });
});

describe("/api/desktop/projects/[id]/health", () => {
  it("returns 404 when the project id is outside the user's visibility", async () => {
    asAuthed();
    const res = await projectHealthGET(
      makeReq("https://x/api/desktop/projects/p-stranger/health"),
      { params: Promise.resolve({ id: "p-stranger" }) },
    );
    expect(res.status).toBe(404);
    expect(getProjectHealth).not.toHaveBeenCalled();
  });

  it("returns the health payload for a visible project", async () => {
    asAuthed();
    const payload = {
      projectId: "p-personal-1",
      projectName: "Web",
      state: "ok",
      alerts24h: { total: 0, critical: 0, warning: 0, info: 0 },
      uptime: { monitorsTotal: 1, monitorsDown: 0, avgResponseMs: 187 },
      lastDeploy: null,
      integrations: ["vercel", "capture"],
    };
    (getProjectHealth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(payload);

    const res = await projectHealthGET(
      makeReq("https://x/api/desktop/projects/p-personal-1/health"),
      { params: Promise.resolve({ id: "p-personal-1" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(getProjectHealth).toHaveBeenCalledWith("p-personal-1");
  });

  it("returns 404 when the service can't resolve the project (deleted mid-flight)", async () => {
    asAuthed();
    (getProjectHealth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await projectHealthGET(
      makeReq("https://x/api/desktop/projects/p-org-1/health"),
      { params: Promise.resolve({ id: "p-org-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("401s when the bearer fails", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    const res = await projectHealthGET(
      makeReq("https://x/api/desktop/projects/p-personal-1/health"),
      { params: Promise.resolve({ id: "p-personal-1" }) },
    );
    expect(res.status).toBe(401);
    expect(getProjectHealth).not.toHaveBeenCalled();
  });
});
