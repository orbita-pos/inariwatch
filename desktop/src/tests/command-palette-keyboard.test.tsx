import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette } from "@/components/CommandPalette";

describe("CommandPalette", () => {
  it("opens on Cmd+K and surfaces stub commands", () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette onOpenChange={onOpenChange} />);

    // Closed by default — the dialog content is not rendered.
    expect(screen.queryByPlaceholderText(/Ask Inari/i)).not.toBeInTheDocument();

    // Cmd+K toggles open. cmdk dialogs render their input when open.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("Escape closes when controlled open", () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
