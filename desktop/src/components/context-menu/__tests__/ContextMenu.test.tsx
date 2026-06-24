import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextMenu, type ContextMenuItem } from "@/components/context-menu/ContextMenu";

function makeItems(): ContextMenuItem[] {
  return [
    { id: "open", label: "Open", onSelect: vi.fn() },
    { id: "copy", label: "Copy", onSelect: vi.fn() },
    { id: "fix", label: "Fix", onSelect: vi.fn(), disabled: true },
  ];
}

describe("<ContextMenu>", () => {
  it("does not render the menu before right-click", () => {
    render(
      <ContextMenu items={makeItems()} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on right-click and renders all enabled items", () => {
    render(
      <ContextMenu items={makeItems()} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByTestId("menuitem-open")).toBeTruthy();
    expect(screen.getByTestId("menuitem-copy")).toBeTruthy();
    expect(screen.getByTestId("menuitem-fix")).toBeTruthy();
  });

  it("invokes the onSelect of the clicked item and dismisses", () => {
    const items = makeItems();
    render(
      <ContextMenu items={items} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-open"));
    expect(items[0]?.onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not invoke onSelect for a disabled item", () => {
    const items = makeItems();
    render(
      <ContextMenu items={items} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.click(screen.getByTestId("menuitem-fix"));
    expect(items[2]?.onSelect).not.toHaveBeenCalled();
    // Disabled click is a no-op but does not dismiss the menu.
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("dismisses on Escape", () => {
    render(
      <ContextMenu items={makeItems()} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dismisses on outside mousedown", () => {
    render(
      <>
        <ContextMenu items={makeItems()} testId="ctx">
          <span>target</span>
        </ContextMenu>
        <button data-testid="outside">outside</button>
      </>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders empty children without crashing when items is empty", () => {
    render(
      <ContextMenu items={[]} testId="ctx">
        <span>target</span>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx"));
    // Empty `items` short-circuits open — no menu node mounts.
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
