/**
 * v0.3 Phase A — endpoint smoke tests for the 5 new /api/desktop/*
 * widget routes.
 *
 * Each test:
 *   - Mocks `lib/auth-extension` so the Bearer-token check is hermetic
 *     (no DB roundtrip, no encryption keys).
 *   - Mocks `lib/services/desktop-widgets.service` so we can assert the
 *     route handler:
 *       (1) gates on the Bearer-token check (401 when missing/invalid),
 *       (2) passes through the resolved `projectIds` to the service,
 *       (3) shapes the response correctly (status code + JSON payload),
 *       (4) honours `?limit=…` clamping.
 *
 *  We deliberately avoid spinning up a real Next.js dev server — these
 *  are unit-shaped checks of the route handlers. Service-layer
 *  correctness is its own concern (DB access etc) and lives elsewhere.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth-extension", () => {
  return {
    authenticateExtensionToken: vi.fn(),
    unauthorized: () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  };
});

vi.mock("@/lib/services/desktop-widgets.service", () => {
  return {
    getUptimeSummary:    vi.fn(),
    getDeploysSummary:   vi.fn(),
    getOncallStatus:     vi.fn(),
    getCommunityTrending: vi.fn(),
    getStatusSummary:    vi.fn(),
  };
});

import { authenticateExtensionToken } from "@/lib/auth-extension";
import {
  getUptimeSummary,
  getDeploysSummary,
  getOncallStatus,
  getCommunityTrending,
  getStatusSummary,
} from "@/lib/services/desktop-widgets.service";
import { GET as uptimeGET } from "../uptime/route";
import { GET as deploysGET } from "../deploys/route";
import { GET as oncallGET } from "../oncall/route";
import { GET as trendingGET } from "../community/trending/route";
import { GET as statusGET } from "../status-summary/route";

const PROJECTS = ["p1", "p2"];

function makeReq(url = "https://app.inariwatch.com/api/desktop/x", headers: Record<string, string> = {}) {
  return new NextRequest(new URL(url), {
    headers: new Headers({
      authorization: "Bearer test-token",
      ...headers,
    }),
  });
}

function asAuthed() {
  (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    userId: "u1",
    projectIds: PROJECTS,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/desktop/uptime", () => {
  it("returns the service payload as JSON when authed", async () => {
    asAuthed();
    (getUptimeSummary as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      monitors: [],
      downCount: 0,
      total: 0,
      avgResponseMs: null,
    });

    const res = await uptimeGET(makeReq());
    expect(res.status).toBe(200);
    expect(getUptimeSummary).toHaveBeenCalledWith(PROJECTS);
    expect(await res.json()).toEqual({
      monitors: [],
      downCount: 0,
      total: 0,
      avgResponseMs: null,
    });
  });

  it("rejects with 401 when the Bearer token is invalid", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await uptimeGET(makeReq());
    expect(res.status).toBe(401);
    expect(getUptimeSummary).not.toHaveBeenCalled();
  });
});

describe("/api/desktop/deploys", () => {
  it("clamps the limit query param", async () => {
    asAuthed();
    (getDeploysSummary as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      deploys: [],
      failedCount: 0,
    });

    // Out-of-range high → clamped to 32.
    await deploysGET(makeReq("https://x/api/desktop/deploys?limit=9999"));
    expect(getDeploysSummary).toHaveBeenCalledWith(PROJECTS, 32);

    // Out-of-range low → clamped to 1.
    (getDeploysSummary as unknown as ReturnType<typeof vi.fn>).mockClear();
    await deploysGET(makeReq("https://x/api/desktop/deploys?limit=0"));
    expect(getDeploysSummary).toHaveBeenCalledWith(PROJECTS, 1);

    // No param → default 8.
    (getDeploysSummary as unknown as ReturnType<typeof vi.fn>).mockClear();
    await deploysGET(makeReq("https://x/api/desktop/deploys"));
    expect(getDeploysSummary).toHaveBeenCalledWith(PROJECTS, 8);
  });

  it("rejects with 401 when unauthed", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await deploysGET(makeReq());
    expect(res.status).toBe(401);
  });
});

describe("/api/desktop/oncall", () => {
  it("scopes service call to user's projectIds", async () => {
    asAuthed();
    (getOncallStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      schedules: [],
      totalAssignments: 0,
    });
    const res = await oncallGET(makeReq());
    expect(res.status).toBe(200);
    expect(getOncallStatus).toHaveBeenCalledWith(PROJECTS);
  });

  it("401 when unauthed", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await oncallGET(makeReq());
    expect(res.status).toBe(401);
  });
});

describe("/api/desktop/community/trending", () => {
  it("does NOT scope by projects (community knowledge is global)", async () => {
    asAuthed();
    (getCommunityTrending as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await trendingGET(makeReq("https://x/api/desktop/community/trending?limit=5"));
    expect(getCommunityTrending).toHaveBeenCalledWith(5);
  });

  it("401 when unauthed", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await trendingGET(makeReq("https://x/api/desktop/community/trending"));
    expect(res.status).toBe(401);
  });
});

describe("/api/desktop/status-summary", () => {
  it("returns the typed summary payload when authed", async () => {
    asAuthed();
    const payload = {
      state: "operational",
      alertsCritical24h: 0,
      alertsWarning24h: 0,
      monitorsDown: 0,
      monitorsTotal: 0,
      projectCount: 2,
      lastAlertAt: null,
    };
    (getStatusSummary as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(payload);

    const res = await statusGET(makeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(getStatusSummary).toHaveBeenCalledWith(PROJECTS);
  });

  it("401 when unauthed", async () => {
    (authenticateExtensionToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await statusGET(makeReq());
    expect(res.status).toBe(401);
  });
});
