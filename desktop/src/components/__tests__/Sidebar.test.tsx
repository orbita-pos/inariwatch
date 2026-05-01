import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Sidebar } from "@/components/sidebar/Sidebar";
import { __resetMainWindowForTests, useMainWindow } from "@/lib/store/mainWindow";

describe("Sidebar", () => {
  beforeEach(() => {
    __resetMainWindowForTests();
  });
  afterEach(() => {
    __resetMainWindowForTests();
  });

  it("clicking an item activates the corresponding route", async () => {
    render(<Sidebar />);

    expect(useMainWindow.getState().route).toBe("inbox");

    await act(async () => {
      fireEvent.click(screen.getByTestId("sidebar-item-settings"));
    });

    expect(useMainWindow.getState().route).toBe("settings");
    expect(screen.getByTestId("sidebar-item-settings")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("Cmd+1 / Cmd+5 jumps to Inbox / Settings without focus on the item", async () => {
    render(<Sidebar />);

    await act(async () => {
      fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    });
    expect(useMainWindow.getState().route).toBe("settings");

    await act(async () => {
      fireEvent.keyDown(window, { key: "1", metaKey: true });
    });
    expect(useMainWindow.getState().route).toBe("inbox");
  });

  it("Enter on a focused sidebar item activates it", async () => {
    render(<Sidebar />);

    const memory = screen.getByTestId("sidebar-item-memory");
    memory.focus();

    await act(async () => {
      fireEvent.keyDown(memory, { key: "Enter" });
    });

    expect(useMainWindow.getState().route).toBe("memory");
  });
});
