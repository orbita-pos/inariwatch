/**
 * Sesión 19 — DockDiff routes apply / reject through the local
 * remediation IPC when entered via the orchestrator.
 *
 * Boots DockDiff with a Fix synthesized from a remediation draft (via
 * `useChat.openRemediationDraft`), hits the Apply button, and asserts
 * `applyRemediation` was called with the orchestrator's session id —
 * NOT the legacy S16 `applyFix`. Same dance for Reject.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string) =>
    code
      .split("\n")
      .map((line) => `<span class="line">${line}</span>`)
      .join(""),
  ),
}));

const { applyRemediationMock, rejectRemediationMock, applyFixMock, rejectFixMock } =
  vi.hoisted(() => ({
    applyRemediationMock: vi.fn(async () => ({
      success: true,
      commitSha: "abc1234",
      filesTouched: ["src/main.rs"],
      message: "Fix applied + commit abc1234",
    })),
    rejectRemediationMock: vi.fn(async () => ({ success: true })),
    applyFixMock: vi.fn(async () => ({ success: true })),
    rejectFixMock: vi.fn(async () => ({ success: true })),
  }));

vi.mock("@/lib/dock-ipc", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/dock-ipc")>("@/lib/dock-ipc");
  return {
    ...actual,
    applyRemediation: applyRemediationMock,
    rejectRemediation: rejectRemediationMock,
    applyFix: applyFixMock,
    rejectFix: rejectFixMock,
    getFixById: vi.fn(async () => null),
    openEapReceipt: vi.fn(async () => {}),
    modifyWithAi: vi.fn(async () => ({ success: false })),
  };
});

import { DockDiff } from "@/screens/DockDiff";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";

const KNOWN_DIFF = [
  "--- a/src/main.rs",
  "+++ b/src/main.rs",
  "@@ -1,2 +1,2 @@",
  "-fn off_by_one() -> usize { 1 }",
  "+fn off_by_one() -> usize { 0 }",
  " fn main() {}",
  "",
].join("\n");

describe("DockDiff (S19 remediation route)", () => {
  afterEach(() => {
    __resetChatStoreForTests();
    applyRemediationMock.mockClear();
    rejectRemediationMock.mockClear();
    applyFixMock.mockClear();
    rejectFixMock.mockClear();
  });

  it("apply button invokes applyRemediation with the orchestrator session id", async () => {
    act(() => {
      useChat.getState().openRemediationDraft({
        sessionId: "sess-uuid-19",
        repoId: "repo-1",
        diff: KNOWN_DIFF,
        filesTouched: ["src/main.rs"],
        errorMessage: "off_by_one returns wrong value",
      });
    });

    render(<DockDiff />);

    // Make sure the diff body is in the DOM (DiffViewer's stub renders
    // each line through Shiki's mocked codeToHtml).
    await waitFor(() =>
      expect(screen.getByTestId("dock-diff-filename")).toHaveTextContent(
        "src/main.rs",
      ),
    );

    fireEvent.click(screen.getByTestId("dock-diff-apply"));

    await waitFor(() => expect(applyRemediationMock).toHaveBeenCalledTimes(1));
    expect(applyRemediationMock).toHaveBeenCalledWith("sess-uuid-19");
    // Legacy stub MUST NOT fire — we want the new IPC.
    expect(applyFixMock).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByTestId("dock-diff-apply-success")).toBeTruthy(),
    );
  });

  it("reject confirmation invokes rejectRemediation with the orchestrator session id", async () => {
    act(() => {
      useChat.getState().openRemediationDraft({
        sessionId: "sess-rej-1",
        repoId: "repo-1",
        diff: KNOWN_DIFF,
        filesTouched: ["src/main.rs"],
        errorMessage: "boom",
      });
    });

    render(<DockDiff />);

    fireEvent.click(screen.getByTestId("dock-diff-reject"));
    // The Dialog renders the textarea + the confirm button mounts.
    await waitFor(() =>
      expect(screen.getByTestId("dock-diff-reject-confirm")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("dock-diff-reject-confirm"));

    await waitFor(() =>
      expect(rejectRemediationMock).toHaveBeenCalledTimes(1),
    );
    expect(rejectRemediationMock).toHaveBeenCalledWith(
      "sess-rej-1",
      undefined,
    );
    expect(rejectFixMock).not.toHaveBeenCalled();
  });
});
