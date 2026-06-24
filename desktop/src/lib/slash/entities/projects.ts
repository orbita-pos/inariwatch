/**
 * Inari Live Phase 5.2 — project entity provider.
 *
 * Wraps the existing `cloud_projects_list` Tauri IPC (which fronts
 * `/api/desktop/projects`). Collapses the cloud `ProjectRow` into the
 * generic `ProjectEntity` shape consumed by the project picker.
 *
 * Errors collapse to an empty array so the picker degrades to "no
 * projects available" rather than surfacing a transient cloud blip
 * as a chat-surface error.
 */
import {
  cloudProjectsList,
  type ProjectList,
  type ProjectRow,
} from "../../cloud-ipc";

import type { ProjectEntity } from "./types";

/** Exported for tests. */
export function toProjectEntity(p: ProjectRow): ProjectEntity {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    workspaceName: p.workspaceName,
    state: p.state as string,
    // `localPath` lives in a separate per-project IPC
    // (project_get_local_path); the picker fetches it lazily for the
    // hovered row if it needs to suggest a clone path. Not part of
    // the base list payload — keep the provider thin.
  };
}

export interface ListProjectsDeps {
  list?: () => Promise<ProjectList>;
}

export async function listProjects(
  deps: ListProjectsDeps = {},
): Promise<ProjectEntity[]> {
  const list = deps.list ?? cloudProjectsList;
  try {
    const result = await list();
    return result.projects.map(toProjectEntity);
  } catch {
    // Not paired / 401 / network — picker falls back to empty.
    return [];
  }
}
