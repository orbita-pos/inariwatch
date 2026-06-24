import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DockAlert } from "@/screens/DockAlert";
import { __resetChatStoreForTests, useChat } from "@/lib/store/chat";
import type { Alert } from "@/types/alert";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const FIXTURE: Alert = {
  id: "alert_1",
  title: "TypeError: cannot read property 'id' of undefined",
  source: "sentry",
  severity: "high",
  timestamp: Date.now() - 3 * 60_000,
  stackTrace: [
    "TypeError: cannot read property 'id' of undefined",
    "    at handler (web/lib/auth.ts:42:12)",
    "    at process (web/api/route.ts:88:5)",
  ].join("\n"),
  stackLanguage: "typescript",
  aiDiagnosis: "Likely a missing null guard around the user object.",
  suggestedFixId: "fix_1",
  metadata: { confidence: 87, risk: 23, linesChanged: 47 },
};

describe("DockAlert", () => {
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("renders header / body / footer with the mocked alert", () => {
    render(<DockAlert alertOverride={FIXTURE} />);

    // Header
    const header = screen.getByTestId("dock-alert-header");
    expect(header).toHaveTextContent(/TypeError/);
    expect(screen.getByTestId("dock-alert-source")).toHaveTextContent(/Sentry/);

    // Body — stack trace + diagnosis + meta chips.
    expect(screen.getByTestId("dock-alert-stack")).toHaveTextContent(/auth.ts/);
    expect(screen.getByTestId("dock-alert-diagnosis")).toHaveTextContent(
      /null guard/,
    );
    expect(screen.getByTestId("confidence-badge")).toBeInTheDocument();
    expect(screen.getByTestId("dock-alert-risk")).toHaveTextContent(/23%/);
    expect(screen.getByTestId("dock-alert-lines")).toHaveTextContent(/47/);

    // Footer — 3 buttons.
    expect(screen.getByTestId("dock-alert-view-diff")).toBeInTheDocument();
    expect(screen.getByTestId("dock-alert-apply")).toBeInTheDocument();
    expect(screen.getByTestId("dock-alert-open-editor")).toBeInTheDocument();
  });

  it("clicking [View diff] transitions the store to mode='diff'", () => {
    // Pre-populate the store via the public action so the screen reads
    // it the same way production would.
    act(() => {
      useChat.getState().openAlert(FIXTURE);
    });
    expect(useChat.getState().mode).toBe("alert");

    render(<DockAlert />);
    act(() => {
      fireEvent.click(screen.getByTestId("dock-alert-view-diff"));
    });

    expect(useChat.getState().mode).toBe("diff");
    expect(useChat.getState().pendingDiff).toEqual({
      alertId: "alert_1",
      fixId: "fix_1",
    });
  });

  it("renders the empty-state when no alert is in the store", () => {
    render(<DockAlert />);
    expect(screen.getByTestId("dock-alert")).toHaveAttribute(
      "data-empty",
      "true",
    );
    expect(screen.getByText(/No alert selected/)).toBeInTheDocument();
  });
});
