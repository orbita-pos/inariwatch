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

// Stub Shiki — same shape DiffViewer.test.tsx uses.
vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string) =>
    code
      .split("\n")
      .map((line) => `<span class="line">${line}</span>`)
      .join(""),
  ),
}));

// Hoisted mocks for the IPC layer so we can assert on calls + drive
// the apply microinteraction's success state deterministically.
const { applyFixMock, rejectFixMock, modifyWithAiMock } = vi.hoisted(() => ({
  applyFixMock: vi.fn(async () => ({ success: true, deploymentUrl: "https://staging.inari.dev/deploy/123" })),
  rejectFixMock: vi.fn(async () => ({ success: true })),
  modifyWithAiMock: vi.fn(async () => ({ success: true, newDiff: "new" })),
}));

vi.mock("@/lib/dock-ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dock-ipc")>(
    "@/lib/dock-ipc",
  );
  return {
    ...actual,
    applyFix: applyFixMock,
    rejectFix: rejectFixMock,
    modifyWithAi: modifyWithAiMock,
    getFixById: vi.fn(async () => null),
    openEapReceipt: vi.fn(async () => {}),
  };
});

import { DockDiff } from "@/screens/DockDiff";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";
import { GATE_NAMES, type Fix } from "@/types/alert";

const FIX: Fix = {
  id: "fix_1",
  alertId: "alert_1",
  filePath: "web/lib/auth.ts",
  language: "typescript",
  diff: [
    "--- a/web/lib/auth.ts",
    "+++ b/web/lib/auth.ts",
    "@@ -40,5 +40,7 @@",
    " function handler(req) {",
    "+  if (!req.user) return null;",
    "+  if (!req.user.id) return null;",
    "   return req.user.id;",
    " }",
  ].join("\n"),
  gates: GATE_NAMES.map((name, idx) => ({
    id: String(idx + 1),
    name,
    status: idx < 16 ? "pass" : "skipped",
  })),
  replayMatch: true,
  eapSignature:
    "ed25519:9f1c3a8b7d6e5f4c3a2b1d0e9f8c7b6a5e4d3c2b1a09876f5e4d3c2b1a098765",
};

describe("DockDiff", () => {
  afterEach(() => {
    __resetChatStoreForTests();
    applyFixMock.mockClear();
    rejectFixMock.mockClear();
    modifyWithAiMock.mockClear();
  });

  it("clicking [Apply & commit] calls IPC and shows success microinteraction", async () => {
    render(<DockDiff fixOverride={FIX} />);

    expect(screen.getByTestId("dock-diff-filename")).toHaveTextContent(
      /auth\.ts/,
    );
    expect(screen.getByTestId("dock-diff-replay")).toHaveAttribute(
      "data-replay-state",
      "match",
    );
    expect(screen.getByTestId("dock-diff-eap")).toHaveAttribute(
      "data-eap-state",
      "signed",
    );

    const apply = screen.getByTestId("dock-diff-apply");
    act(() => {
      fireEvent.click(apply);
    });

    await waitFor(() => {
      expect(screen.getByTestId("dock-diff-apply-success")).toBeInTheDocument();
    });
    expect(applyFixMock).toHaveBeenCalledWith("alert_1", "fix_1");
  });

  it("clicking [Reject] opens the reason dialog and confirm calls IPC", async () => {
    // Pre-populate the alert + fix state so backToAlert has a target.
    act(() => {
      useChat.getState().openAlert({
        id: "alert_1",
        title: "x",
        source: "sentry",
        severity: "high",
        timestamp: Date.now(),
        stackTrace: "",
        stackLanguage: "typescript",
        aiDiagnosis: "",
        suggestedFixId: "fix_1",
        metadata: { confidence: 80, risk: 20, linesChanged: 5 },
      });
      useChat.getState().openDiff(FIX);
    });

    render(<DockDiff />);

    act(() => {
      fireEvent.click(screen.getByTestId("dock-diff-reject"));
    });

    // Dialog mounts via Radix portal — querying by testid still works.
    const reasonInput = await screen.findByTestId("dock-diff-reject-reason");
    act(() => {
      fireEvent.change(reasonInput, { target: { value: "wrong file" } });
    });

    act(() => {
      fireEvent.click(screen.getByTestId("dock-diff-reject-confirm"));
    });

    await waitFor(() => {
      expect(rejectFixMock).toHaveBeenCalledWith("fix_1", "wrong file");
    });
  });

  it("toggling the view persists across modes without crashing", () => {
    render(<DockDiff fixOverride={FIX} />);
    expect(screen.getByTestId("dock-diff-view-inline")).toHaveAttribute(
      "data-active",
      "true",
    );
    act(() => {
      fireEvent.click(screen.getByTestId("dock-diff-view-side-by-side"));
    });
    expect(screen.getByTestId("dock-diff-view-side-by-side")).toHaveAttribute(
      "data-active",
      "true",
    );
  });
});
