import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DockIdle } from "@/screens/DockIdle";
import { __resetChatStoreForTests } from "@/lib/store/chat";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

describe("DockIdle", () => {
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("renders the 4 sections (input, quick actions, recent activity, footer) with mocked data", () => {
    const repo = {
      id: "r1",
      name: "radar",
      branch: "feat/inari-live",
      changes: 0,
    };
    const indexStats = {
      symbolCount: 12_345,
      lastIndexedAtMs: Date.now() - 5 * 60_000,
    };
    const activity = [
      {
        id: "a1",
        kind: "fs_change" as const,
        summary: "modified: web/middleware.ts",
        timestampMs: Date.now() - 30_000,
      },
      {
        id: "a2",
        kind: "git_event" as const,
        summary: "branch switched to feat/inari-live",
        timestampMs: Date.now() - 90_000,
      },
    ];

    render(
      <DockIdle
        initialRepo={repo}
        initialIndexStats={indexStats}
        initialActivity={activity}
        // Pin the daemon-event subscription to a noop so the test
        // doesn't drift on real-time arrivals.
        subscribeEvents={() => () => {}}
      />,
    );

    // Section 1 — top: input + status row.
    expect(screen.getByTestId("dock-input")).toBeInTheDocument();
    const statusRow = screen.getByTestId("dock-status-row");
    expect(statusRow).toHaveTextContent(/radar/);
    expect(statusRow).toHaveTextContent(/feat\/inari-live/);
    expect(statusRow).toHaveTextContent(/idle/);

    // Section 2 — middle: quick actions grid (3 cards).
    expect(screen.getByTestId("quick-actions")).toBeInTheDocument();
    expect(screen.getByTestId("quick-action-chat")).toBeInTheDocument();
    expect(screen.getByTestId("quick-action-search")).toBeInTheDocument();
    expect(screen.getByTestId("quick-action-fix")).toBeInTheDocument();

    // Section 3 — bottom: recent activity feed (2 entries from fixture).
    expect(screen.getByTestId("recent-activity")).toBeInTheDocument();
    expect(screen.getAllByTestId("recent-activity-entry")).toHaveLength(2);

    // Section 4 — footer: stats line.
    const footer = screen.getByTestId("dock-idle-footer");
    expect(footer).toHaveTextContent(/12,345 symbols/);
    expect(footer).toHaveTextContent(/indexed/);
    expect(footer).toHaveTextContent(/ESC/i);
  });
});
