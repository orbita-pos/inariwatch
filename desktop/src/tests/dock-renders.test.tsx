import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DockShell } from "@/components/dock/DockShell";

describe("DockShell", () => {
  it("renders the empty/idle state with Inari-ready copy", () => {
    render(<DockShell />);
    expect(screen.getByTestId("dock-shell")).toBeInTheDocument();
    // Header chip + footer hint reach the DOM
    expect(screen.getByText("Inari Live")).toBeInTheDocument();
    expect(screen.getByText("Inari is ready")).toBeInTheDocument();
    expect(screen.getByTestId("dock-footer")).toHaveTextContent("idle");
  });
});
