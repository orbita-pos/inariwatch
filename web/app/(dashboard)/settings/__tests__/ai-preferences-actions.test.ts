/**
 * v0.3 S3 — server-action unit tests for the AI Preferences toggle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  selectMock,
  updateMock,
  fromMock,
  whereMock,
  limitMock,
  setMock,
  updateWhereMock,
  getServerSessionMock,
  revalidatePathMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  fromMock: vi.fn(),
  whereMock: vi.fn(),
  limitMock: vi.fn(),
  setMock: vi.fn(),
  updateWhereMock: vi.fn(async () => undefined),
  getServerSessionMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: selectMock,
    update: updateMock,
  },
  organizations: { _name: "organizations" },
  organizationMembers: { _name: "organization_members" },
  users: { _name: "users" },
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

import { setLocalNotifyEnabled } from "@/app/(dashboard)/settings/ai-preferences-actions";

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  fromMock.mockReset();
  whereMock.mockReset();
  limitMock.mockReset();
  setMock.mockReset();
  updateWhereMock.mockReset();
  getServerSessionMock.mockReset();
  revalidatePathMock.mockReset();

  // db.select() chain — used twice (users.activeOrgId + members fallback).
  selectMock.mockReturnValue({ from: fromMock });
  fromMock.mockReturnValue({ where: whereMock });
  whereMock.mockReturnValue({ limit: limitMock });
  // db.update() chain.
  updateMock.mockReturnValue({ set: setMock });
  setMock.mockReturnValue({ where: updateWhereMock });
});

afterEach(() => vi.restoreAllMocks());

describe("setLocalNotifyEnabled", () => {
  it("rejects when not authenticated", async () => {
    getServerSessionMock.mockResolvedValueOnce(null);
    const r = await setLocalNotifyEnabled(true);
    expect(r).toEqual({ ok: false, error: "not authenticated" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("rejects when the user has no resolvable workspace", async () => {
    getServerSessionMock.mockResolvedValueOnce({ user: { id: "u-1" } });
    // users.activeOrgId lookup → no rows.
    limitMock.mockResolvedValueOnce([{ activeOrgId: null }]);
    // members fallback → no rows.
    limitMock.mockResolvedValueOnce([]);
    const r = await setLocalNotifyEnabled(true);
    expect(r).toEqual({ ok: false, error: "no active workspace" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("updates the organization row and revalidates settings", async () => {
    getServerSessionMock.mockResolvedValueOnce({ user: { id: "u-1" } });
    limitMock.mockResolvedValueOnce([{ activeOrgId: "org-1" }]);
    const r = await setLocalNotifyEnabled(true);
    expect(r).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({ localNotifyEnabled: true });
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("falls back to the first org membership when activeOrgId is null", async () => {
    getServerSessionMock.mockResolvedValueOnce({ user: { id: "u-1" } });
    limitMock.mockResolvedValueOnce([{ activeOrgId: null }]);
    limitMock.mockResolvedValueOnce([{ orgId: "org-2" }]);
    const r = await setLocalNotifyEnabled(false);
    expect(r).toEqual({ ok: true });
    expect(setMock).toHaveBeenCalledWith({ localNotifyEnabled: false });
  });
});
