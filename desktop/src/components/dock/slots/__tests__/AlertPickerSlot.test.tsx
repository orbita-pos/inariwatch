/**
 * Phase 5.7 — AlertPickerSlot tests.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AlertPickerSlot,
  alertsFromMemory,
  mergeAlertSources,
} from "../AlertPickerSlot";
import type { AlertEntity } from "@/lib/slash/entities/types";
import { ScopedMemory } from "@/lib/slash/scoped-memory";
import type { SlotSpec } from "@/lib/slash/suspended-command";

const spec: SlotSpec = {
  kind: "alert",
  name: "hash",
  prompt: "which alert?",
};

const alert = (over: Partial<AlertEntity> = {}): AlertEntity => ({
  id: "a-1",
  hash: "1a2b3c4d5e6f7890",
  title: "TypeError in /api/foo",
  severity: "critical",
  projectName: "InariWatch",
  createdAt: "2026-05-15T12:00:00.000Z",
  isResolved: false,
  ...over,
});

describe("alertsFromMemory()", () => {
  it("returns empty for an empty buffer", () => {
    expect(alertsFromMemory([])).toEqual([]);
  });

  it("walks entries newest-first and pulls alert entities", () => {
    let t = 1_000;
    const m = new ScopedMemory({ now: () => ++t });
    m.push({
      commandName: "alerts",
      args: {},
      summary: "",
      entities: [
        { type: "alert", id: "old-1", hash: null, title: "Old", severity: "info" },
      ],
    });
    m.push({
      commandName: "alerts",
      args: {},
      summary: "",
      entities: [
        { type: "alert", id: "new-1", hash: "abc", title: "New", severity: "critical" },
        { type: "project", id: "p-1", name: "ignored" },
      ],
    });
    const result = alertsFromMemory(m.recent());
    expect(result.map((a) => a.id)).toEqual(["new-1", "old-1"]);
  });
});

describe("mergeAlertSources()", () => {
  it("promoted-first, fresh after, dedupe by id", () => {
    const promoted = [alert({ id: "a-1", title: "Promoted" })];
    const fresh = [
      alert({ id: "a-1", title: "Same id from fresh" }),
      alert({ id: "a-2", title: "Fresh only" }),
    ];
    const result = mergeAlertSources(promoted, fresh);
    expect(result).toHaveLength(2);
    expect(result[0]!.entity.id).toBe("a-1");
    expect(result[0]!.promoted).toBe(true);
    expect(result[0]!.entity.title).toBe("Promoted"); // promoted wins
    expect(result[1]!.entity.id).toBe("a-2");
    expect(result[1]!.promoted).toBe(false);
  });
});

describe("<AlertPickerSlot>", () => {
  function listFactory(rows: AlertEntity[]) {
    return vi.fn(async (_n?: number) => rows);
  }

  it("renders loading while the IPC is pending AND no promoted entries", () => {
    const list = vi.fn(() => new Promise<AlertEntity[]>(() => {}));
    render(
      <AlertPickerSlot spec={spec} onPick={vi.fn()} list={list} />,
    );
    expect(screen.getByTestId("alert-picker-loading")).toBeTruthy();
  });

  it("renders alerts on resolution", async () => {
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([alert({ id: "a-1", title: "T1" })])}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("alert-picker-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("T1");
    });
  });

  it("promotes alerts from scoped memory above the fresh list", async () => {
    let t = 1_000;
    const memory = new ScopedMemory({ now: () => ++t });
    memory.push({
      commandName: "alerts",
      args: {},
      summary: "",
      entities: [
        {
          type: "alert",
          id: "promoted-1",
          hash: "deadbeefdeadbeef",
          title: "Promoted Title",
          severity: "critical",
        },
      ],
    });
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={vi.fn()}
        scopedMemory={memory}
        list={listFactory([alert({ id: "fresh-1", title: "Fresh Title" })])}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("alert-picker-row");
      // Promoted first
      expect(rows[0]!.getAttribute("data-promoted")).toBe("true");
      expect(rows[0]!.textContent).toContain("Promoted Title");
      // Fresh after
      expect(rows[1]!.textContent).toContain("Fresh Title");
    });
  });

  it("filters by case-insensitive substring across title / severity / hash", async () => {
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([
          alert({ id: "a-1", title: "Payment timeout", severity: "critical" }),
          alert({ id: "a-2", title: "DB pool exhausted", severity: "warning" }),
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("alert-picker-row")).toHaveLength(2);
    });
    fireEvent.change(screen.getByTestId("alert-picker-search"), {
      target: { value: "payment" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("alert-picker-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("Payment timeout");
    });
  });

  it("clicking a row dispatches onPick with id + hash + title", async () => {
    const onPick = vi.fn();
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          alert({ id: "a-1", hash: "abc", title: "T" }),
        ])}
      />,
    );
    const row = await screen.findByTestId("alert-picker-row");
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith({
      kind: "alert",
      id: "a-1",
      hash: "abc",
      title: "T",
    });
  });

  it("falls back to id when hash is null", async () => {
    const onPick = vi.fn();
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([alert({ id: "raw", hash: null })])}
      />,
    );
    const row = await screen.findByTestId("alert-picker-row");
    fireEvent.click(row);
    expect(onPick.mock.calls[0]![0].hash).toBe("raw");
  });

  it("Enter picks the highlighted row (arrow keys move highlight)", async () => {
    const onPick = vi.fn();
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          alert({ id: "a-1", hash: "h1", title: "first" }),
          alert({ id: "a-2", hash: "h2", title: "second" }),
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("alert-picker-row")).toHaveLength(2);
    });
    const input = screen.getByTestId("alert-picker-search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "alert",
      id: "a-2",
      hash: "h2",
      title: "second",
    });
  });

  it("renders 'no scope' message when both sources are empty", async () => {
    render(
      <AlertPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([])}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("alert-picker-empty")).toBeTruthy();
    });
  });
});
