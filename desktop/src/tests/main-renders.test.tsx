import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MainShell } from "@/components/main/MainShell";

describe("MainShell", () => {
  it("renders the sidebar with all five nav items", () => {
    render(<MainShell />);
    expect(screen.getByTestId("main-shell")).toBeInTheDocument();
    expect(screen.getByTestId("main-sidebar")).toBeInTheDocument();
    for (const label of ["Inbox", "Activity", "Memory", "Patterns", "Settings"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });
});
