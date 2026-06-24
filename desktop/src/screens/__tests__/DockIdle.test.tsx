import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DockIdle } from "@/screens/DockIdle";

/**
 * Pre-2026-05-07 the dock had a separate "idle" mode rendering a
 * 4-section dashboard (input + repo status + quick-actions grid +
 * recent-activity feed + stats footer). The chat-first reframe
 * deleted that pattern: `DockIdle` is now a thin wrapper that
 * forwards to `DockConversation`, whose empty state IS the welcome
 * screen.
 *
 * This smoke test pins the wrapper contract — that rendering
 * `<DockIdle />` mounts the conversation surface — so a future
 * refactor that decouples them again has to update both.
 */
describe("DockIdle", () => {
  it("renders the conversation surface (empty state)", () => {
    render(<DockIdle />);
    expect(screen.getByTestId("dock-conversation")).toBeInTheDocument();
    expect(screen.getByTestId("dock-conversation-empty")).toBeInTheDocument();
  });
});
