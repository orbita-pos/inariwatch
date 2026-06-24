import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StacktraceContextMenu } from "@/components/context-menu/StacktraceContextMenu";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";
import type { StacktraceLocation } from "@/lib/stacktrace";

const location: StacktraceLocation = {
  file: "/srv/app/server.js",
  line: 42,
  col: 13,
  fn: "handler",
  start: 0,
  end: 30,
  raw: "at handler (/srv/app/server.js:42:13)",
};

beforeEach(() => {
  __resetChatStoreForTests();
});

describe("<StacktraceContextMenu>", () => {
  it("dispatches desktop_tool_confirm with ambient-context session id", async () => {
    const invokeConfirm = vi
      .fn()
      .mockResolvedValue({ kind: "output", invocation_id: "x", output: { value: {} }, permission: "confirm" });

    render(
      <StacktraceContextMenu
        location={location}
        invokeConfirm={invokeConfirm as never}
        testId="ctx"
      >
        <span>at handler …</span>
      </StacktraceContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-open-editor"));

    expect(invokeConfirm).toHaveBeenCalledTimes(1);
    const [tool, args, sessionId] = invokeConfirm.mock.calls[0]!;
    expect(tool).toBe("desktop.open_in_editor");
    expect(args).toMatchObject({ path: "/srv/app/server.js", line: 42 });
    expect(sessionId).toBe("ambient-context");
  });

  it("Copy path writes the path-only to clipboard via the seam", async () => {
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    render(
      <StacktraceContextMenu
        location={location}
        copyToClipboard={copyToClipboard}
        testId="ctx"
      >
        <span>at handler …</span>
      </StacktraceContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-copy-path"));

    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith("/srv/app/server.js");
  });

  it("Fix with AI prefills the chat input with the location embedded", () => {
    render(
      <StacktraceContextMenu location={location} alertId="a-1" testId="ctx">
        <span>at handler …</span>
      </StacktraceContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-fix-ai"));

    const input = useChat.getState().inputValue;
    expect(input).toContain("Fix this stacktrace");
    expect(input).toContain("/srv/app/server.js:42:13");
    expect(input).toContain("alert a-1");
    expect(useChat.getState().mode).toBe("conversation");
  });

  it("Investigate produces a different intro string", () => {
    render(
      <StacktraceContextMenu location={location} testId="ctx">
        <span>at handler …</span>
      </StacktraceContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-investigate"));

    const input = useChat.getState().inputValue;
    expect(input.startsWith("Investigate")).toBe(true);
    expect(input).toContain("/srv/app/server.js:42:13");
  });
});
