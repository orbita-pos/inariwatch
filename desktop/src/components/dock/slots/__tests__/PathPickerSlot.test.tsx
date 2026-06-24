/**
 * Phase 5.6 — PathPickerSlot tests.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PathPickerSlot } from "../PathPickerSlot";
import type { PathEntity } from "@/lib/slash/entities/types";
import type { SlotSpec } from "@/lib/slash/suspended-command";

const spec: SlotSpec = {
  kind: "path",
  name: "path",
  prompt: "which folder?",
};

const pathRow = (over: Partial<PathEntity> = {}): PathEntity => ({
  path: "D:\\web",
  lastUsedAt: 2_000,
  ...over,
});

function listFactory(rows: PathEntity[]) {
  return vi.fn(async (_n?: number) => rows);
}

describe("<PathPickerSlot>", () => {
  it("renders the loading state until the IPC resolves", () => {
    const list = vi.fn(() => new Promise<PathEntity[]>(() => {}));
    render(
      <PathPickerSlot spec={spec} onPick={vi.fn()} list={list} />,
    );
    expect(screen.getByTestId("path-picker-loading")).toBeTruthy();
  });

  it("renders the empty state + Browse… CTA when no recent paths", async () => {
    const pickFolder = vi.fn(async () => "D:\\new-repo");
    const onPick = vi.fn();
    render(
      <PathPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([])}
        pickFolder={pickFolder}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("path-picker-empty")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("path-picker-browse"));
    await waitFor(() => {
      expect(pickFolder).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith({ kind: "path", value: "D:\\new-repo" });
    });
  });

  it("renders recent paths newest-first", async () => {
    render(
      <PathPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([
          pathRow({ path: "D:\\web", lastUsedAt: 3_000 }),
          pathRow({ path: "C:\\old", lastUsedAt: 2_000 }),
        ])}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("path-picker-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain("D:\\web");
      expect(rows[1]!.textContent).toContain("C:\\old");
    });
  });

  it("clicking a row dispatches onPick with the path verbatim", async () => {
    const onPick = vi.fn();
    render(
      <PathPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([pathRow({ path: "D:\\web" })])}
      />,
    );
    const row = await screen.findByTestId("path-picker-row");
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith({ kind: "path", value: "D:\\web" });
  });

  it("arrow keys + Enter pick the highlighted row", async () => {
    const onPick = vi.fn();
    render(
      <PathPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          pathRow({ path: "A" }),
          pathRow({ path: "B" }),
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("path-picker-row")).toHaveLength(2);
    });
    const root = screen.getByTestId("path-picker");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ kind: "path", value: "B" });
  });

  it("Browse… opens the native folder picker and forwards the result", async () => {
    const pickFolder = vi.fn(async () => "E:\\picked");
    const onPick = vi.fn();
    render(
      <PathPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([pathRow({ path: "D:\\web" })])}
        pickFolder={pickFolder}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("path-picker-browse")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("path-picker-browse"));
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith({ kind: "path", value: "E:\\picked" });
    });
  });

  it("Browse… cancel (returns null) keeps the picker open without dispatching", async () => {
    const pickFolder = vi.fn(async () => null);
    const onPick = vi.fn();
    render(
      <PathPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([pathRow({ path: "D:\\web" })])}
        pickFolder={pickFolder}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("path-picker-browse")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("path-picker-browse"));
    await waitFor(() => {
      expect(pickFolder).toHaveBeenCalled();
    });
    expect(onPick).not.toHaveBeenCalled();
  });
});
