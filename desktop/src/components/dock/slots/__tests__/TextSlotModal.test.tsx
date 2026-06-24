/**
 * Phase 5.5 — TextSlotModal tests.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TextSlotModal } from "../TextSlotModal";
import type { SlotSpec } from "@/lib/slash/suspended-command";

const spec: SlotSpec = {
  kind: "text",
  name: "message",
  prompt: "to Jose",
  placeholder: "Type a message…",
};

describe("<TextSlotModal>", () => {
  it("renders the placeholder + footer hint", () => {
    render(<TextSlotModal spec={spec} onPick={vi.fn()} />);
    expect(
      screen.getByTestId("text-slot-input").getAttribute("placeholder"),
    ).toBe("Type a message…");
    expect(screen.getByTestId("text-slot-modal").textContent).toContain(
      "Enter to send",
    );
  });

  it("submit button is disabled until the input has non-whitespace content", () => {
    render(<TextSlotModal spec={spec} onPick={vi.fn()} />);
    const submit = screen.getByTestId("text-slot-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("text-slot-input"), {
      target: { value: "hi" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("Enter (no shift) dispatches onPick with the trimmed value", () => {
    const onPick = vi.fn();
    render(<TextSlotModal spec={spec} onPick={onPick} />);
    const input = screen.getByTestId("text-slot-input");
    fireEvent.change(input, { target: { value: "  hello  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ kind: "text", value: "hello" });
  });

  it("Shift+Enter does NOT submit (newline allowed)", () => {
    const onPick = vi.fn();
    render(<TextSlotModal spec={spec} onPick={onPick} />);
    const input = screen.getByTestId("text-slot-input");
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("clicking submit dispatches onPick", () => {
    const onPick = vi.fn();
    render(<TextSlotModal spec={spec} onPick={onPick} />);
    fireEvent.change(screen.getByTestId("text-slot-input"), {
      target: { value: "click me" },
    });
    fireEvent.click(screen.getByTestId("text-slot-submit"));
    expect(onPick).toHaveBeenCalledWith({ kind: "text", value: "click me" });
  });

  it("Enter on empty input is a no-op", () => {
    const onPick = vi.fn();
    render(<TextSlotModal spec={spec} onPick={onPick} />);
    fireEvent.keyDown(screen.getByTestId("text-slot-input"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("falls back to a generic placeholder when spec has none", () => {
    const noPlaceholderSpec: SlotSpec = {
      kind: "text",
      name: "x",
      prompt: "what?",
    };
    render(<TextSlotModal spec={noPlaceholderSpec} onPick={vi.fn()} />);
    const ph = screen
      .getByTestId("text-slot-input")
      .getAttribute("placeholder");
    expect(ph).toBeTruthy();
    expect((ph ?? "").length).toBeGreaterThan(0);
  });
});
