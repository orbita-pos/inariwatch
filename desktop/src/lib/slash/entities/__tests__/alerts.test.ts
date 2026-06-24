/**
 * Phase 5.2 — alert entity provider tests.
 */
import { describe, expect, it, vi } from "vitest";

import { listAlerts, toAlertEntity } from "../alerts";
import type { CloudAlert } from "../../../cloud-ipc";

const alert = (over: Partial<CloudAlert> = {}): CloudAlert => ({
  id: "a-1",
  title: "TypeError in /api/foo",
  body: null,
  severity: "critical",
  aiReasoning: null,
  sourceIntegrations: ["sentry"],
  projectName: "InariWatch",
  fingerprint: null,
  inariHash: "1a2b3c4d5e6f7890",
  isRead: false,
  isResolved: false,
  createdAt: "2026-05-15T12:00:00.000Z",
  ...over,
});

describe("toAlertEntity()", () => {
  it("maps the CloudAlert shape onto the AlertEntity shape", () => {
    const entity = toAlertEntity(alert());
    expect(entity).toEqual({
      id: "a-1",
      hash: "1a2b3c4d5e6f7890",
      title: "TypeError in /api/foo",
      severity: "critical",
      projectName: "InariWatch",
      createdAt: "2026-05-15T12:00:00.000Z",
      isResolved: false,
    });
  });

  it("preserves a null inariHash on legacy alerts", () => {
    const entity = toAlertEntity(alert({ inariHash: null }));
    expect(entity.hash).toBeNull();
  });
});

describe("listAlerts()", () => {
  it("forwards the limit verbatim to the IPC", async () => {
    const list = vi.fn(async () => [alert()]);
    await listAlerts(50, { list });
    expect(list).toHaveBeenCalledWith(50);
  });

  it("uses default limit=20 when none provided", async () => {
    const list = vi.fn(async () => [alert()]);
    await listAlerts(undefined, { list });
    expect(list).toHaveBeenCalledWith(20);
  });

  it("degrades to empty array when IPC throws", async () => {
    const list = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await listAlerts(20, { list });
    expect(result).toEqual([]);
  });

  it("returns resolved alerts (greyed in the picker, not hidden)", async () => {
    const list = vi.fn(async () => [
      alert({ id: "a-active" }),
      alert({ id: "a-resolved", isResolved: true }),
    ]);
    const result = await listAlerts(20, { list });
    expect(result.map((a) => a.id)).toEqual(["a-active", "a-resolved"]);
    expect(result[1]!.isResolved).toBe(true);
  });
});
