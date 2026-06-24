/**
 * Phase 5.6 completion — ProjectLinkSlot tests.
 *
 * Three rendering states: wizard active / existing-projects list /
 * empty bridge. Each is driven via the test-injection props so we
 * don't need a real Tauri runtime or Zustand store.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// AddProjectWizard's `initialize` effect calls Tauri `listen()` on
// mount; mock it so jsdom doesn't reject. We never actually need
// the real channel — `wizardState` drives the picker.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

import { ProjectLinkSlot, sortProjectsForLink } from "../ProjectLinkSlot";
import type { ProjectEntity } from "@/lib/slash/entities/projects";
import type { SlotSpec } from "@/lib/slash/suspended-command";

const spec: SlotSpec = {
  kind: "project_link",
  name: "project_id",
  prompt: "link a project",
  optionsHint: { path: "D:\\web" },
};

const project = (over: Partial<ProjectEntity> = {}): ProjectEntity => ({
  id: "p-1",
  name: "InariWatch",
  slug: "inariwatch",
  workspaceName: "Personal",
  state: "live",
  ...over,
});

function listFactory(rows: ProjectEntity[]) {
  return vi.fn(async () => rows);
}

describe("sortProjectsForLink()", () => {
  it("floats needs_setup / created / setting_up rows to the top", () => {
    const sorted = sortProjectsForLink([
      project({ id: "p-live", name: "Live App", state: "live" }),
      project({ id: "p-ns", name: "Bravo", state: "needs_setup" }),
      project({ id: "p-cr", name: "Alpha", state: "created" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["p-cr", "p-ns", "p-live"]);
  });

  it("alphabetises within each tier", () => {
    const sorted = sortProjectsForLink([
      project({ id: "p-b", name: "Bravo", state: "live" }),
      project({ id: "p-a", name: "Alpha", state: "live" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["p-a", "p-b"]);
  });
});

describe("<ProjectLinkSlot> — state A (wizard active)", () => {
  it("renders the wizard inline when a payload is pending", () => {
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{
          payload: { projectId: "p-123", projectSlug: "demo" },
          verified: false,
        }}
      />,
    );
    expect(screen.getByTestId("project-link-slot-wizard")).toBeTruthy();
    expect(screen.queryByTestId("project-link-slot-list")).toBeNull();
    expect(screen.queryByTestId("project-link-slot-bridge")).toBeNull();
  });

  it("dispatches onPick when verified flips true", async () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{
          payload: { projectId: "p-verified" },
          verified: false,
        }}
      />,
    );
    expect(onPick).not.toHaveBeenCalled();
    rerender(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{
          payload: { projectId: "p-verified" },
          verified: true,
        }}
      />,
    );
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith({
        kind: "project_link",
        projectId: "p-verified",
      });
    });
  });

  it("does NOT dispatch onPick twice when verified replays", async () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{
          payload: { projectId: "p-verified" },
          verified: true,
        }}
      />,
    );
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1));
    rerender(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{
          payload: { projectId: "p-verified" },
          verified: true,
        }}
      />,
    );
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe("<ProjectLinkSlot> — state B (existing projects list)", () => {
  it("renders projects, needs_setup at top", async () => {
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([
          project({ id: "p-live", name: "Live", state: "live" }),
          project({ id: "p-ns", name: "Setup Me", state: "needs_setup" }),
        ])}
        setLocalPath={vi.fn()}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    await waitFor(() => {
      const rows = screen.getAllByTestId("project-link-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]!.getAttribute("data-state")).toBe("needs_setup");
      expect(rows[0]!.textContent).toContain("Setup Me");
      expect(rows[1]!.textContent).toContain("Live");
    });
  });

  it("clicking a row calls projectSetLocalPath(id, path) before onPick", async () => {
    const onPick = vi.fn();
    const setLocalPath = vi.fn(async () => undefined);
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([
          project({ id: "p-x", name: "Target", state: "needs_setup" }),
        ])}
        setLocalPath={setLocalPath}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    const row = await screen.findByTestId("project-link-row");
    fireEvent.click(row);
    await waitFor(() => {
      expect(setLocalPath).toHaveBeenCalledWith("p-x", "D:\\web");
      expect(onPick).toHaveBeenCalledWith({
        kind: "project_link",
        projectId: "p-x",
        name: "Target",
      });
    });
  });

  it("still calls onPick even if projectSetLocalPath throws (best-effort persistence)", async () => {
    const onPick = vi.fn();
    const setLocalPath = vi.fn(async () => {
      throw new Error("not a directory");
    });
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={onPick}
        list={listFactory([project({ id: "p-x" })])}
        setLocalPath={setLocalPath}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    const row = await screen.findByTestId("project-link-row");
    fireEvent.click(row);
    await waitFor(() => {
      expect(onPick).toHaveBeenCalled();
    });
  });

  it("'Add a new project' button fires the injected onOpenWebFlow", async () => {
    const onOpenWebFlow = vi.fn();
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([project({ id: "p-1" })])}
        setLocalPath={vi.fn()}
        onOpenWebFlow={onOpenWebFlow}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    const addNew = await screen.findByTestId("project-link-add-new");
    fireEvent.click(addNew);
    expect(onOpenWebFlow).toHaveBeenCalledTimes(1);
  });

  it("displays the path the user typed in the banner", async () => {
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([project()])}
        setLocalPath={vi.fn()}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("project-link-slot-list").textContent).toContain(
        "D:\\web",
      );
    });
  });
});

describe("<ProjectLinkSlot> — state C (empty bridge)", () => {
  it("renders the 'Open Add Project on web' CTA when no projects exist", async () => {
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("project-link-slot-bridge")).toBeTruthy();
      expect(screen.getByTestId("project-link-open-web")).toBeTruthy();
    });
  });

  it("'Open Add Project on web' fires onOpenWebFlow when injected", async () => {
    const onOpenWebFlow = vi.fn();
    render(
      <ProjectLinkSlot
        spec={spec}
        onPick={vi.fn()}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        onOpenWebFlow={onOpenWebFlow}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    const cta = await screen.findByTestId("project-link-open-web");
    fireEvent.click(cta);
    expect(onOpenWebFlow).toHaveBeenCalledTimes(1);
  });

  it("renders without a path banner when the spec has no path hint", async () => {
    const noPathSpec: SlotSpec = {
      kind: "project_link",
      name: "project_id",
      prompt: "link a project",
    };
    render(
      <ProjectLinkSlot
        spec={noPathSpec}
        onPick={vi.fn()}
        list={listFactory([])}
        setLocalPath={vi.fn()}
        wizardState={{ payload: null, verified: false }}
      />,
    );
    await waitFor(() => {
      const bridge = screen.getByTestId("project-link-slot-bridge");
      expect(bridge).toBeTruthy();
      expect(bridge.textContent).not.toContain("D:\\web");
    });
  });
});
