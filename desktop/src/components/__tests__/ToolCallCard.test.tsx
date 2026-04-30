import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolCallCard } from "@/components/ToolCallCard";

describe("ToolCallCard", () => {
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

    // Click the toggle button.
    fireEvent.click(screen.getByRole("button", { name: /search_codebase/i }));

    expect(card).toHaveAttribute("data-open", "true");
    const body = screen.getByTestId("tool-call-body");
    expect(body).toBeInTheDocument();
    expect(body).toHaveTextContent(/auth middleware/);
    expect(body).toHaveTextContent(/matches/);
  });
});
