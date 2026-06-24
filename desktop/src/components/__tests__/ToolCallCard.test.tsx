import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolCallCard } from "@/components/ToolCallCard";
import {
  __resetChatStoreForTests,
  useChat,
  type ToolCall,
} from "@/lib/store/chat";
import {
  __resetSettingsStoreForTests,
  useSettings,
} from "@/lib/store/settings";

// Mock the IPC boundary so the card's confirm flow + the witness modal
// never reach Tauri. Returning empty payloads is fine — the audit-ui
// IPC inside the modal only fires when invocationId is non-null AND
// the chip was clicked, neither of which the confirm-flow tests do.
vi.mock("@/lib/audit-ui-ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-ui-ipc")>(
    "@/lib/audit-ui-ipc",
  );
  return {
    ...actual,
    desktopAuditGet: vi.fn(),
    desktopAuditVerify: vi.fn(),
  };
});

vi.mock("@/lib/tool-invoke-ipc", () => ({
  desktopToolInvoke: vi.fn(),
  desktopToolConfirm: vi.fn(),
  desktopToolCatalog: vi.fn(),
}));

import { desktopToolConfirm } from "@/lib/tool-invoke-ipc";

const confirmMock = desktopToolConfirm as unknown as ReturnType<typeof vi.fn>;

describe("ToolCallCard", () => {
  beforeEach(() => {
    __resetChatStoreForTests();
    __resetSettingsStoreForTests();
    confirmMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Pre-S6 placeholder behavior preserved: card collapses + expands,
  // body shows input + output. Same assertions as the original test.
  it("starts collapsed and expands on click", () => {
    render(
      <ToolCallCard
        toolCall={{
          id: "tc1",
          name: "search_codebase",
          input: { query: "auth middleware" },
          output: { matches: 3 },
        }}
      />,
    );

    const card = screen.getByTestId("tool-call-card");
    expect(card).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("tool-call-body")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /search_codebase/i }));

    expect(card).toHaveAttribute("data-open", "true");
    const body = screen.getByTestId("tool-call-body");
    expect(body).toBeInTheDocument();
    expect(body).toHaveTextContent(/auth middleware/);
    expect(body).toHaveTextContent(/matches/);
  });

  it("renders the status badge for each lifecycle state", () => {
    const states: Array<NonNullable<ToolCall["status"]>> = [
      "pending",
      "confirming",
      "executing",
      "done",
      "failed",
      "denied",
    ];
    for (const status of states) {
      const { unmount } = render(
        <ToolCallCard toolCall={{ id: `tc-${status}`, name: "x", status }} />,
      );
      const card = screen.getByTestId("tool-call-card");
      expect(card).toHaveAttribute("data-status", status);
      expect(screen.getByTestId(`tool-call-status-${status}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("dispatches desktop_tool_confirm and patches the store on click", async () => {
    const messageId = "msg-1";
    useChat.setState({
      messages: [
        {
          id: messageId,
          role: "assistant",
          content: "",
          createdAt: 0,
          toolCalls: [
            {
              id: "tc-confirm",
              name: "local.run_shell",
              input: { cmd: "ls" },
              status: "confirming",
              permission: "confirm",
            },
          ],
        },
      ],
    });
    confirmMock.mockResolvedValue({
      kind: "output",
      invocation_id: "inv-after-confirm",
      output: { value: { ok: true }, summary: null },
      permission: "confirm",
    });

    render(
      <ToolCallCard
        messageId={messageId}
        toolCall={
          useChat.getState().messages[0]!.toolCalls![0]!
        }
        invokeConfirm={confirmMock as never}
      />,
    );

    expect(screen.getByTestId("tool-call-confirm-prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tool-call-confirm-button"));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith("local.run_shell", { cmd: "ls" }, null);
    });

    await waitFor(() => {
      const tc = useChat.getState().messages[0]!.toolCalls![0]!;
      expect(tc.status).toBe("done");
      expect(tc.invocationId).toBe("inv-after-confirm");
      expect(tc.output).toEqual({ ok: true });
    });
  });

  it("flips the call to failed on cancel click", () => {
    const messageId = "msg-2";
    useChat.setState({
      messages: [
        {
          id: messageId,
          role: "assistant",
          content: "",
          createdAt: 0,
          toolCalls: [
            {
              id: "tc-cancel",
              name: "comm.send_telegram",
              input: { chat_id: "@me", text: "hi" },
              status: "confirming",
            },
          ],
        },
      ],
    });

    render(
      <ToolCallCard
        messageId={messageId}
        toolCall={useChat.getState().messages[0]!.toolCalls![0]!}
      />,
    );

    fireEvent.click(screen.getByTestId("tool-call-cancel-button"));
    const tc = useChat.getState().messages[0]!.toolCalls![0]!;
    expect(tc.status).toBe("failed");
    expect(tc.error).toMatch(/cancelled/i);
    // Cancel must not fire the IPC.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("renders the denied banner with a deeplink that focuses the tool in Settings", () => {
    render(
      <ToolCallCard
        toolCall={{
          id: "tc-denied",
          name: "local.run_shell",
          status: "denied",
          error: "permission denied",
        }}
      />,
    );

    const link = screen.getByTestId("tool-call-open-permissions");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(useSettings.getState().activeSection).toBe("permissions");
    expect(useSettings.getState().focusedTool).toBe("local.run_shell");
  });

  it("renders the witness chip with first 8 chars of the invocation id", () => {
    render(
      <ToolCallCard
        toolCall={{
          id: "tc-done",
          name: "desktop.read_clipboard",
          status: "done",
          invocationId: "abcdef0123456789cafef00d",
          output: { text: "ok" },
        }}
      />,
    );

    const chip = screen.getByTestId("tool-call-witness-chip");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("verified:abcdef01");
  });

  it("hides the witness chip until invocation_id arrives", () => {
    render(
      <ToolCallCard
        toolCall={{
          id: "tc-pending",
          name: "desktop.read_clipboard",
          status: "pending",
          input: {},
        }}
      />,
    );
    expect(screen.queryByTestId("tool-call-witness-chip")).not.toBeInTheDocument();
  });
});
