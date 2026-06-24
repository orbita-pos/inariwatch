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

  it("Cmd+1 / Cmd+6 jumps to Inbox / Settings without focus on the item", async () => {
    render(<Sidebar />);

    // Settings is the 6th nav item after S11 added the Audit route at
    // index 3 (Inbox=1, Activity=2, Audit=3, Memory=4, Patterns=5,
    // Settings=6).
    await act(async () => {
      fireEvent.keyDown(window, { key: "6", ctrlKey: true });
    });
    expect(useMainWindow.getState().route).toBe("settings");

    await act(async () => {
      fireEvent.keyDown(window, { key: "1", metaKey: true });
    });
    expect(useMainWindow.getState().route).toBe("inbox");
  });

  it("Cmd+3 jumps to the new S11 Audit route", async () => {
    render(<Sidebar />);

    await act(async () => {
      fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    });
    expect(useMainWindow.getState().route).toBe("audit");
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
