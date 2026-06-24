import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DockShell } from "@/components/dock/DockShell";
import { __resetChatStoreForTests } from "@/lib/store/chat";

// The DockShell installs a chat-stream driver on mount which probes
// `daemon:event` over Tauri. jsdom has no Tauri runtime; mock the
// listener so it resolves to a no-op unlisten without warning.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

describe("DockShell", () => {
  afterEach(() => {
    __resetChatStoreForTests();
  });

  it("mounts the shell and defaults to idle mode", () => {
    render(<DockShell />);
    const shell = screen.getByTestId("dock-shell");
    expect(shell).toBeInTheDocument();
    expect(shell.dataset.mode).toBe("idle");
    // The idle screen renders its own footer + input.
    expect(screen.getByTestId("dock-idle-footer")).toBeInTheDocument();
    expect(screen.getByTestId("dock-input")).toBeInTheDocument();
  });
});
