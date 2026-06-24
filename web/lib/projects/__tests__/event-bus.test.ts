import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __projectEventListenerCountForTests,
  __resetProjectEventBusForTests,
  publishProjectEvent,
  subscribeProjectEvents,
} from "../event-bus";

describe("project event bus — subscribe / publish lifecycle", () => {
  afterEach(() => {
    __resetProjectEventBusForTests();
  });

  it("delivers events to all subscribers for the matching projectId", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeProjectEvents("p1", a);
    subscribeProjectEvents("p1", b);

    publishProjectEvent("p1", {
      type: "project.state.changed",
      state: "verified",
      at: "2026-05-08T00:00:00Z",
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({
      type: "project.state.changed",
      state: "verified",
      at: "2026-05-08T00:00:00Z",
    });
  });

  it("does NOT deliver events to subscribers of other projects", () => {
    const p1 = vi.fn();
    const p2 = vi.fn();
    subscribeProjectEvents("p1", p1);
    subscribeProjectEvents("p2", p2);

    publishProjectEvent("p1", {
      type: "project.first_event_arrived",
      alertId: "alert-A",
      at: "2026-05-08T00:00:01Z",
    });

    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).not.toHaveBeenCalled();
  });

  it("unsubscribe removes only that listener and cleans the bucket on empty", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeProjectEvents("p1", a);
    const offB = subscribeProjectEvents("p1", b);
    expect(__projectEventListenerCountForTests("p1")).toBe(2);

    offA();
    expect(__projectEventListenerCountForTests("p1")).toBe(1);
    publishProjectEvent("p1", {
      type: "project.state.changed",
      state: "live",
      at: "2026-05-08T00:00:02Z",
    });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    offB();
    expect(__projectEventListenerCountForTests("p1")).toBe(0);
  });

  it("a throwing listener does not starve the others", () => {
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribeProjectEvents("p1", bad);
    subscribeProjectEvents("p1", good);

    publishProjectEvent("p1", {
      type: "project.state.changed",
      state: "verified",
      at: "2026-05-08T00:00:03Z",
    });

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it("publish on an unknown projectId is a silent no-op", () => {
    expect(() =>
      publishProjectEvent("never-subscribed", {
        type: "project.first_event_arrived",
        alertId: "x",
        at: "2026-05-08T00:00:04Z",
      }),
    ).not.toThrow();
  });
});
