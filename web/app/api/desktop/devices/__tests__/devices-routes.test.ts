/**
 * Session 1 — /api/desktop/devices route smoke tests.
 *
 * These tests exercise the auth layer + response shape without mocking
 * the full drizzle query chain. Deeper db-shape coverage lives in the
 * Rust integration suite at desktop/src-tauri/tests/devices_endpoints.rs
 * which exercises the same endpoints over real HTTP.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Drizzle's chain API is awkward to mock; we stub the db with a minimal
// thenable that returns predictable rows. Each route uses one or two
// chains, so the surface is small.
const dbMock = vi.hoisted(() => {
  type Chain = Promise<unknown[]> & {
    from:    () => Chain;
    where:   () => Chain;
    orderBy: () => Chain;
    limit:   () => Chain;
    set:     () => Chain;
    values:  () => Chain;
    returning: () => Chain;
  };
  function chain(rows: unknown[]): Chain {
    const c = Promise.resolve(rows) as Chain;
    c.from      = () => chain(rows);
    c.where     = () => chain(rows);
    c.orderBy   = () => chain(rows);
    c.limit     = () => chain(rows);
    c.set       = () => chain(rows);
    c.values    = () => chain(rows);
    c.returning = () => chain(rows);
    return c;
  }
  // Keep a stack of pre-canned result sets the routes will consume in
  // order. Tests push expected rows; each select/update/insert chain
  // pops one entry.
  const queue: unknown[][] = [];
  return {
    queue,
    select: vi.fn(() => chain(queue.shift() ?? [])),
    update: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => chain(queue.shift() ?? [])),
    delete: vi.fn(() => chain(queue.shift() ?? [])),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: dbMock.select,
    update: dbMock.update,
    insert: dbMock.insert,
    delete: dbMock.delete,
  },
  // Schema re-exports — `eq` / `and` / `isNull` / `desc` / `sql` are
  // imported from drizzle-orm directly elsewhere; the routes only use
  // the `deviceTokens` table reference, which isn't introspected at
  // runtime so a plain stub is fine.
  deviceTokens: { deviceId: "device_id", userId: "user_id", lastSeenAt: "last_seen_at", revokedAt: "revoked_at", label: "label", os: "os", hostname: "hostname", appVersion: "app_version", createdAt: "created_at", tokenHash: "token_hash" },
  users: {},
}));

const authMocks = vi.hoisted(() => ({
  authenticateExtensionToken: vi.fn(),
  resolveDesktopActor:        vi.fn(),
}));

vi.mock("@/lib/auth-extension", () => ({
  authenticateExtensionToken: authMocks.authenticateExtensionToken,
  resolveDesktopActor:        authMocks.resolveDesktopActor,
  isValidUUID: (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
}));

import { GET as listGET }       from "../route";
import { PATCH as renamePATCH } from "../[deviceId]/route";
import { DELETE as revokeDEL }  from "../[deviceId]/route";
import { POST as signOutPOST }  from "../sign-out-all/route";

function makeReq(url: string, init?: RequestInit) {
  return new NextRequest(new URL(url), init);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.queue.length = 0;
});

describe("GET /api/desktop/devices", () => {
  it("returns 401 when neither bearer nor session resolves a user", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue(null);
    const res = await listGET(makeReq("https://x/api/desktop/devices"));
    expect(res.status).toBe(401);
  });

  it("returns the user's active devices with isCurrent flagged", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({
      userId: "u-1",
      deviceId: "d-current",
    });
    const now = new Date("2026-05-08T01:00:00Z");
    dbMock.queue.push([
      {
        deviceId:   "d-current",
        label:      "laptop-jesus",
        os:         "macos",
        hostname:   "laptop-jesus.local",
        appVersion: "0.1.0",
        createdAt:  now,
        lastSeenAt: now,
      },
      {
        deviceId:   "d-other",
        label:      "macmini-studio",
        os:         "macos",
        hostname:   null,
        appVersion: null,
        createdAt:  now,
        lastSeenAt: now,
      },
    ]);
    const res = await listGET(makeReq("https://x/api/desktop/devices"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      devices: Array<{ deviceId: string; isCurrent: boolean }>;
      currentDeviceId: string | null;
    };
    expect(body.devices.length).toBe(2);
    expect(body.currentDeviceId).toBe("d-current");
    const current = body.devices.find((d) => d.deviceId === "d-current");
    const other   = body.devices.find((d) => d.deviceId === "d-other");
    expect(current?.isCurrent).toBe(true);
    expect(other?.isCurrent).toBe(false);
  });
});

describe("PATCH /api/desktop/devices/[deviceId]", () => {
  it("returns 401 when not authed", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue(null);
    const res = await renamePATCH(
      makeReq("https://x/api/desktop/devices/00000000-0000-4000-8000-000000000000", {
        method: "PATCH",
        body: JSON.stringify({ label: "x" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ deviceId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid uuid", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    const res = await renamePATCH(
      makeReq("https://x/api/desktop/devices/not-a-uuid", {
        method: "PATCH",
        body: JSON.stringify({ label: "x" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ deviceId: "not-a-uuid" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when no row matches the user + device", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    dbMock.queue.push([]); // empty .returning() result
    const res = await renamePATCH(
      makeReq("https://x/api/desktop/devices/11111111-2222-4333-8444-555555555555", {
        method: "PATCH",
        body: JSON.stringify({ label: "new label" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ deviceId: "11111111-2222-4333-8444-555555555555" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with the renamed row on success", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    dbMock.queue.push([{ deviceId: "11111111-2222-4333-8444-555555555555", label: "renamed" }]);
    const res = await renamePATCH(
      makeReq("https://x/api/desktop/devices/11111111-2222-4333-8444-555555555555", {
        method: "PATCH",
        body: JSON.stringify({ label: "renamed" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ deviceId: "11111111-2222-4333-8444-555555555555" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { label: string };
    expect(body.label).toBe("renamed");
  });
});

describe("DELETE /api/desktop/devices/[deviceId]", () => {
  it("returns 401 when not authed", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue(null);
    const res = await revokeDEL(
      makeReq("https://x/api/desktop/devices/00000000-0000-4000-8000-000000000000", { method: "DELETE" }),
      { params: Promise.resolve({ deviceId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with revoked:true on success", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    dbMock.queue.push([{ deviceId: "00000000-0000-4000-8000-000000000000" }]);
    const res = await revokeDEL(
      makeReq("https://x/api/desktop/devices/00000000-0000-4000-8000-000000000000", { method: "DELETE" }),
      { params: Promise.resolve({ deviceId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; revoked: boolean };
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(true);
  });

  it("returns 200 with revoked:false when row already revoked (idempotent)", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    dbMock.queue.push([]); // no matching active row
    const res = await revokeDEL(
      makeReq("https://x/api/desktop/devices/00000000-0000-4000-8000-000000000000", { method: "DELETE" }),
      { params: Promise.resolve({ deviceId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; revoked: boolean };
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(false);
  });
});

describe("POST /api/desktop/devices/sign-out-all", () => {
  it("returns 401 when not authed", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue(null);
    const res = await signOutPOST(
      makeReq("https://x/api/desktop/devices/sign-out-all", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns the revoked count on success", async () => {
    authMocks.resolveDesktopActor.mockResolvedValue({ userId: "u-1" });
    dbMock.queue.push([{ deviceId: "d1" }, { deviceId: "d2" }, { deviceId: "d3" }]);
    const res = await signOutPOST(
      makeReq("https://x/api/desktop/devices/sign-out-all", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; revokedCount: number };
    expect(body.ok).toBe(true);
    expect(body.revokedCount).toBe(3);
  });
});
