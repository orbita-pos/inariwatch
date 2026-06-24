/**
 * Phase 5.1 — `<SlotPicker>` shell smoke tests.
 *
 * Asserts on:
 *   1. Header shows `/cmd → prompt` shape;
 *   2. `data-slot-kind` mirrors `spec.kind` (specialised pickers in
 *      5.2+ keep this contract);
 *   3. Cancel button fires `onCancel`;
 *   4. Esc key inside the picker fires `onCancel`;
 *   5. Hidden test-stub button fires `onPick` with a kind-matched
 *      sentinel value.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SlotPicker } from "../SlotPicker";
import type {
  PartialCommand,
  SlotSpec,
  SlotValue,
} from "@/lib/slash/suspended-command";

function makePartial(over: Partial<PartialCommand> = {}): PartialCommand {
  return {
    command: "whatsapp",
    collectedArgs: {},
    rawArgs: "",
    ...over,
  };
}

function makeSpec(over: Partial<SlotSpec> = {}): SlotSpec {
  return {
    kind: "contact",
    name: "recipient",
    prompt: "who?",
    ...over,
  };
}

describe("<SlotPicker> shell", () => {
  it("renders the command + slot prompt in the header", () => {
    render(
      <SlotPicker
        partial={makePartial()}
        spec={makeSpec()}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const picker = screen.getByTestId("slot-picker");
    expect(picker.textContent).toContain("/whatsapp");
    expect(picker.textContent).toContain("who?");
  });

  it("shows collected args inline in the header when present", () => {
    render(
      <SlotPicker
        partial={makePartial({
          collectedArgs: { recipient: "+1", recipient_display: "Jose" },
          rawArgs: "Jose",
        })}
        spec={makeSpec({ kind: "text", name: "message", prompt: "message?" })}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const picker = screen.getByTestId("slot-picker");
    expect(picker.textContent).toContain("Jose");
    expect(picker.textContent).toContain("message?");
  });

  it("exposes spec.kind via data-slot-kind", () => {
    render(
      <SlotPicker
        partial={makePartial()}
        spec={makeSpec({ kind: "alert", name: "alert", prompt: "which alert?" })}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId("slot-picker").getAttribute("data-slot-kind")).toBe(
      "alert",
    );
  });

  it("calls onCancel when the X button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <SlotPicker
        partial={makePartial()}
        spec={makeSpec()}
        onPick={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("slot-picker-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Escape is pressed inside the picker", () => {
    const onCancel = vi.fn();
    render(
      <SlotPicker
        partial={makePartial()}
        spec={makeSpec()}
        onPick={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("slot-picker"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders a non-empty body for every kind in the union", () => {
    // Phase 5.8 closes the kind switch — every kind now has a
    // specialised picker. Smoke that each one mounts SOMETHING
    // inside the SlotPicker shell so a future kind addition that
    // forgets to wire a body fails fast.
    const kinds: Array<{
      kind: "contact" | "project" | "alert" | "path" | "text" | "project_link";
      name: string;
    }> = [
      { kind: "contact", name: "recipient" },
      { kind: "project", name: "project_id" },
      { kind: "alert", name: "hash" },
      { kind: "path", name: "path" },
      { kind: "text", name: "message" },
      { kind: "project_link", name: "project_id" },
    ];
    for (const k of kinds) {
      const { unmount } = render(
        <SlotPicker
          partial={makePartial()}
          spec={makeSpec({ kind: k.kind, name: k.name, prompt: "?" })}
          onPick={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const picker = screen.getByTestId("slot-picker");
      // Picker has the kind data attribute …
      expect(picker.getAttribute("data-slot-kind")).toBe(k.kind);
      // … AND renders a body with some content (loading / list /
      // input — depends on kind). The header alone is short; we
      // assert the picker contains MORE than the header text.
      expect(picker.textContent!.length).toBeGreaterThan(20);
      unmount();
    }
  });

  it("hidden test stub dispatches onPick with a kind-matched value", () => {
    const cases: SlotValue["kind"][] = [
      "contact",
      "project",
      "alert",
      "path",
      "text",
      "project_link",
    ];
    for (const kind of cases) {
      const onPick = vi.fn();
      const { unmount } = render(
        <SlotPicker
          partial={makePartial()}
          spec={makeSpec({ kind, name: kind, prompt: "?" })}
          onPick={onPick}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId("slot-picker-pick-stub"));
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick.mock.calls[0]![0].kind).toBe(kind);
      unmount();
    }
  });
});
