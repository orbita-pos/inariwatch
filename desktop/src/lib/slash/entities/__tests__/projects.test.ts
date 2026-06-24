/**
 * Phase 5.2 — project entity provider tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  listProjects,
  toProjectEntity,
} from "../projects";
import type { ProjectList, ProjectRow } from "../../../cloud-ipc";

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: "p-1",
  name: "InariWatch",
  slug: "inariwatch",
  state: "live",
  framework: "nextjs",
  host: "vercel",
  organizationId: null,
  workspaceName: "Personal",
  createdAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: null,
  ...over,
});

describe("toProjectEntity()", () => {
  it("maps id / name / slug / workspaceName / state", () => {
    const entity = toProjectEntity(
      row({ id: "abc", name: "Demo", slug: "demo", state: "live" }),
    );
    expect(entity).toMatchObject({
      id: "abc",
      name: "Demo",
      slug: "demo",
      workspaceName: "Personal",
      state: "live",
    });
  });

  it("does not include localPath in the base list payload", () => {
    const entity = toProjectEntity(row());
    expect(entity.localPath).toBeUndefined();
  });
});

describe("listProjects()", () => {
  it("returns the mapped projects on success", async () => {
    const list = vi.fn(
      async (): Promise<ProjectList> => ({
        projects: [row({ id: "1", name: "A" }), row({ id: "2", name: "B" })],
      }),
    );
    const result = await listProjects({ list });
    expect(result.map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("degrades to empty list when the IPC throws", async () => {
    const list = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await listProjects({ list });
    expect(result).toEqual([]);
  });

  it("returns empty when the cloud has no projects", async () => {
    const list = vi.fn(async (): Promise<ProjectList> => ({ projects: [] }));
    const result = await listProjects({ list });
    expect(result).toEqual([]);
  });
});
