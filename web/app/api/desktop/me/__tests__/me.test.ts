/**
 * Session 1 — /api/desktop/me self-info smoke tests.
 *
 * Confirms the endpoint:
 *   - Requires bearer auth
 *   - Returns 401 when bearer doesn't resolve a user
 *   - Includes a `device` block when the bearer matches a device_tokens row
 *   - Returns `device: null` for pre-S1 installs (legacy api_keys path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const dbMock = vi.hoisted(() => {
  type Chain = Promise<unknown[]> & {
    from:    () => Chain;
    where:   () => Chain;
    limit:   () => Chain;
  };
  function chain(rows: unknown[]): Chain {
    const c = Promise.resolve(rows) as Chain;
    c.from  = () => chain(rows);
    c.where = () => chain(rows);
    c.limit = () => chain(rows);
    return c;
  }
  const queue: unknown[][] = [];
  return {
    queue,
    select: vi.fn(() => chain(queue.shift() ?? [])),
  };
});

vi.mock("@/lib/db", () => ({
  db: dbMock,
  deviceTokens: { deviceId: "did", revokedAt: "ra" },
  users:        { id: "id", email: "email", name: "name" },
}));

const authMock = vi.hoisted(() => ({ authenticateExtensionToken: vi.fn() }));
vi.mock("@/lib/auth-extension", () => ({
  authenticateExtensionToken: authMock.authenticateExtensionToken,
}));

import { GET as meGET } from "../route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest(new URL("https://x/api/desktop/me"), { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.queue.length = 0;
});

describe("GET /api/desktop/me", () => {
  it("returns 401 when bearer fails to authenticate", async () => {
    authMock.authenticateExtensionToken.mockResolvedValue(null);
    const res = await meGET(makeReq({ authorization: "Bearer x" }));
    expect(res.status).toBe(401);
  });

  it("returns user + device when authenticated post-S1", async () => {
    authMock.authenticateExtensionToken.mockResolvedValue({
      userId:   "u-1",
      deviceId: "d-1",
      projectIds: [],
    });
    // First select: users
    dbMock.queue.push([{ id: "u-1", email: "x@example.com", name: "Jesus" }]);
    // Second select: device_tokens
    const now = new Date("2026-05-08T12:00:00Z");
    dbMock.queue.push([
      {
        deviceId:   "d-1",
        label:      "laptop-jesus",
        os:         "macos",
        hostname:   "laptop-jesus.local",
        appVersion: "0.1.0",
        createdAt:  now,
        lastSeenAt: now,
      },
    ]);

    const res = await meGET(makeReq({ authorization: "Bearer test" }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      user: { id: string; email: string };
      device: { deviceId: string; label: string; os: string | null } | null;
    };
    expect(body.user.email).toBe("x@example.com");
    expect(body.device?.deviceId).toBe("d-1");
    expect(body.device?.label).toBe("laptop-jesus");
    expect(body.device?.os).toBe("macos");
  });

  it("returns device:null for legacy pre-S1 installs (no deviceId)", async () => {
    authMock.authenticateExtensionToken.mockResolvedValue({
      userId:   "u-legacy",
      projectIds: [],
    });
    dbMock.queue.push([{ id: "u-legacy", email: "legacy@example.com", name: "Legacy" }]);
    // No device_tokens query — auth.deviceId is undefined.

    const res = await meGET(makeReq({ authorization: "Bearer legacy" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { device: unknown };
    expect(body.device).toBeNull();
  });

  it("returns 401 when the user row is missing (deleted account)", async () => {
    authMock.authenticateExtensionToken.mockResolvedValue({
      userId:     "u-deleted",
      projectIds: [],
    });
    dbMock.queue.push([]);
    const res = await meGET(makeReq({ authorization: "Bearer x" }));
    expect(res.status).toBe(401);
  });
});
