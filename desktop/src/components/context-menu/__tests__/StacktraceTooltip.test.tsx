import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StacktraceTooltip } from "@/components/context-menu/StacktraceTooltip";
import type { StacktraceLocation } from "@/lib/stacktrace";

/**
 * Drain any microtasks queued by an `await`-flavoured handler. We
 * use real timers for the resolution step because vitest's
 * `useFakeTimers` patches `setTimeout` into a sync queue and
 * Testing Library's `waitFor` polls via `setTimeout`, which would
 * spin under fake clocks. Flushing one tick of real timers is
 * enough for `Promise.resolve().then(...)` chains to settle.
 */
async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const location: StacktraceLocation = {
  file: "/srv/app/server.js",
  line: 42,
  col: 13,
  fn: "handler",
  start: 0,
  end: 30,
  raw: "at handler (/srv/app/server.js:42:13)",
};

describe("<StacktraceTooltip>", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render the tooltip before hover delay elapses", () => {
    render(
      <StacktraceTooltip location={location} testId="tip">
        <span>at handler …</span>
      </StacktraceTooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId("tip"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders the tooltip after the configured delay", () => {
    render(
      <StacktraceTooltip location={location} delayMs={200} testId="tip">
        <span>at handler …</span>
      </StacktraceTooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId("tip"));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByTestId("tip-location").textContent).toBe(
      "/srv/app/server.js:42:13",
    );
  });

  it("dismisses when the cursor leaves the trigger before the timer fires", () => {
    render(
      <StacktraceTooltip location={location} testId="tip">
        <span>at handler …</span>
      </StacktraceTooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId("tip"));
    fireEvent.mouseLeave(screen.getByTestId("tip"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("Open-in-Editor button calls invokeConfirm with ambient-hover session id", async () => {
    const invokeConfirm = vi
      .fn()
      .mockResolvedValue({ kind: "output", invocation_id: "x", output: { value: {} }, permission: "confirm" });
    render(
      <StacktraceTooltip
        location={location}
        delayMs={50}
        invokeConfirm={invokeConfirm as never}
        testId="tip"
      >
        <span>at handler …</span>
      </StacktraceTooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId("tip"));
    act(() => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.click(screen.getByTestId("tip-open"));
    await flushPromises();

    expect(invokeConfirm).toHaveBeenCalledTimes(1);
    const [tool, args, sessionId] = invokeConfirm.mock.calls[0]!;
    expect(tool).toBe("desktop.open_in_editor");
    expect(args).toMatchObject({ path: "/srv/app/server.js", line: 42 });
    expect(sessionId).toBe("ambient-hover");
  });

  it("Copy-path button writes path-only via the seam", async () => {
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    render(
      <StacktraceTooltip
        location={location}
        delayMs={50}
        copyToClipboard={copyToClipboard}
        testId="tip"
      >
        <span>at handler …</span>
      </StacktraceTooltip>,
    );
    fireEvent.mouseEnter(screen.getByTestId("tip"));
    act(() => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.click(screen.getByTestId("tip-copy"));
    await flushPromises();

    expect(copyToClipboard).toHaveBeenCalledWith("/srv/app/server.js");
  });
});
