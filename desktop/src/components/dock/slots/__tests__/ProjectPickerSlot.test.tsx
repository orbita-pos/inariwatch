/**
 * Phase 5.8 — ProjectPickerSlot tests.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectPickerSlot,
  mergeProjectSources,
  projectsFromMemory,
} from "../ProjectPickerSlot";
import type { ProjectEntity } from "@/lib/slash/entities/types";
import { ScopedMemory } from "@/lib/slash/scoped-memory";
import type { SlotSpec } from "@/lib/slash/suspended-command";

const spec: SlotSpec = {
  kind: "project",
  name: "project_id",
  prompt: "which project?",
};

const project = (over: Partial<ProjectEntity> = {}): ProjectEntity => ({
  id: "p-1",
  name: "InariWatch",
  slug: "inariwatch",
  workspaceName: "Personal",
  state: "live",
  ...over,
});

describe("projectsFromMemory()", () => {
  it("returns empty for an empty buffer", () => {
    expect(projectsFromMemory([])).toEqual([]);
  });

  it("pulls project entities newest-entry-first", () => {
    let t = 1_000;
    const m = new ScopedMemory({ now: () => ++t });
    m.push({
      commandName: "projects",
      args: {},
      summary: "",
      entities: [{ type: "project", id: "old", name: "Old" }],
    });
    m.push({
      commandName: "install",
      args: {},
      summary: "",
      entities: [
        { type: "project", id: "new", name: "New", path: "D:\\new" },
        { type: "alert", id: "a", hash: null, title: "ignored", severity: "info" },
      ],
    });
    const result = projectsFromMemory(m.recent());
    expect(result.map((p) => p.id)).toEqual(["new", "old"]);
    expect(result[0]!.localPath).toBe("D:\\new");
  });
});

describe("mergeProjectSources()", () => {
  it("promoted-first, fresh after, dedupe by id", () => {
    const promoted = [project({ id: "p-1", name: "Promoted" })];
    const fresh = [
      project({ id: "p-1", name: "Same id", state: "live" }),
      project({ id: "p-2", name: "Fresh only", state: "live" }),
    ];
    const result = mergeProjectSources(promoted, fresh);
    expect(result).toHaveLength(2);
    expect(result[0]!.entity.id).toBe("p-1");
    expect(result[0]!.promoted).toBe(true);
    // Memory entry has state="—"; fresh has state="live" → fresh
    // fields fill in.
    expect(result[1]!.entity.id).toBe("p-2");
    expect(result[1]!.promoted).toBe(false);
  });

  it("patches missing state from fresh into promoted-row", () => {
    const promoted = [project({ id: "p-1", state: "—" })];
    const fresh = [project({ id: "p-1", state: "live" })];
    const result = mergeProjectSources(promoted, fresh);
    expect(result[0]!.entity.state).toBe("live");
  });

  it("preserves promoted-row's localPath when fresh has none", () => {
    const promoted = [project({ id: "p-1", localPath: "D:\\web" })];
    const fresh = [project({ id: "p-1" })];
    const result = mergeProjectSources(promoted, fresh);
    expect(result[0]!.entity.localPath).toBe("D:\\web");
  });
});

describe("<ProjectPickerSlot>", () => {
  function listFactory(rows: ProjectEntity[]) {
    return vi.fn(async () => rows);
  }

  it("renders loading while waiting for the IPC AND nothing promoted", () => {
    const list = vi.fn(() => new Promise<ProjectEntity[]>(() => {}));
    render(
      <ProjectPickerSlot spec={spec} onPick={vi.fn()} list={list} />,
    );
    expect(screen.getByTestId("project-picker-loading")).toBeTruthy();
  });

  it("renders projects after the IPC resolves", async () => {
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([project({ name: "Demo" })])}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Demo")).toBeTruthy();
    });
  });

  it("promotes memory entries above the fresh list", async () => {
    let t = 1_000;
    const memory = new ScopedMemory({ now: () => ++t });
    memory.push({
      commandName: "install",
      args: {},
      summary: "",
      entities: [
        {
          type: "project",
          id: "promoted",
          name: "Just Installed",
          path: "D:\\web",
        },
      ],
    });
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={vi.fn()}
        scopedMemory={memory}
        list={listFactory([project({ id: "fresh", name: "Fresh" })])}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("project-picker-row");
      expect(rows[0]!.getAttribute("data-promoted")).toBe("true");
      expect(rows[0]!.textContent).toContain("Just Installed");
      expect(rows[0]!.textContent).toContain("D:\\web");
    });
  });

  it("filters by case-insensitive substring on name / slug / id / workspace", async () => {
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([
          project({ id: "p-a", name: "Alpha", slug: "alpha" }),
          project({ id: "p-b", name: "Beta", slug: "beta", workspaceName: "Team" }),
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("project-picker-row")).toHaveLength(2);
    });
    fireEvent.change(screen.getByTestId("project-picker-search"), {
      target: { value: "team" },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId("project-picker-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("Beta");
    });
  });

  it("clicking dispatches onPick with id / name / path", async () => {
    const onPick = vi.fn();
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          project({ id: "abc", name: "X", localPath: "D:\\x" }),
        ])}
      />,
    );
    const row = await screen.findByTestId("project-picker-row");
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith({
      kind: "project",
      id: "abc",
      name: "X",
      path: "D:\\x",
    });
  });

  it("Enter on the highlighted row picks", async () => {
    const onPick = vi.fn();
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          project({ id: "a", name: "A" }),
          project({ id: "b", name: "B" }),
        ])}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("project-picker-row")).toHaveLength(2);
    });
    const input = screen.getByTestId("project-picker-search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({
      kind: "project",
      id: "b",
      name: "B",
      path: undefined,
    });
  });

  it("renders the 'no projects yet' empty state", async () => {
    render(
      <ProjectPickerSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([])}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("project-picker-empty")).toBeTruthy();
    });
  });
});
