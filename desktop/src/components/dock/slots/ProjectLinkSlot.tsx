/**
 * Phase 5.6 completion — project-link slot.
 *
 * Three states, in priority order:
 *
 *   A. **Wizard active** — `useWizard().payload` is set (the user
 *      kicked off "Add Project" on the web and the relay dispatched a
 *      payload into the desktop store). Renders `AddProjectWizard`
 *      inline; resolves the slot when the wizard verifies.
 *
 *   B. **Existing-projects list** — payload null but
 *      `listProjects()` returned ≥1 cloud project. Renders a picker
 *      so the user can attach `D:\web` to an existing project (e.g.
 *      `jesusbr.com` in `needs_setup`). On pick we call
 *      `projectSetLocalPath` to persist the link locally — the next
 *      `/install <same path>` runs `findProjectByLocalPath` and
 *      auto-resolves without showing this slot again. Footer
 *      "+ Add a new project" opens the web Add-Project flow.
 *
 *   C. **Empty bridge** — payload null AND no cloud projects.
 *      Renders the "Open Add Project on web" CTA. The user has to
 *      create a project before linking.
 *
 * "Open Add Project on web" uses `openMainWindow("projects?…")` so
 * the main window is brought forward (or opened cold) and navigated
 * in one shot — `navigateTo` (used in the original 5.6 ship) only
 * navigates an EXISTING window, which silently no-op'd when the
 * user had the main window closed.
 */
import { ExternalLink, Loader2, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { AddProjectWizard } from "@/screens/wizard/AddProjectWizard";
import { openMainWindow } from "@/lib/dock-ipc";
import { projectSetLocalPath as realSetLocalPath } from "@/lib/ipc/project-local";
import {
  listProjects as realListProjects,
  type ProjectEntity,
} from "@/lib/slash/entities/projects";
import { useWizard } from "@/lib/store/wizard";
import type { SlotSpec, SlotValue } from "@/lib/slash/suspended-command";

export interface ProjectLinkSlotProps {
  spec: SlotSpec;
  onPick: (value: SlotValue) => void;
  /** Test injection — replaces the project-list IPC. */
  list?: typeof realListProjects;
  /** Test injection — replaces `projectSetLocalPath`. */
  setLocalPath?: typeof realSetLocalPath;
  /** Test injection — replaces the navigate-to-web action. */
  onOpenWebFlow?: () => void;
  /**
   * Test injection — overrides `useWizard()` so unit tests can
   * drive payload/verified state without standing up the full
   * Zustand store.
   */
  wizardState?: {
    payload: { projectId: string; projectSlug?: string } | null;
    verified: boolean;
  };
}

/** Projects-in-progress (state-machine "early" rows) float to the top. */
const NEEDS_SETUP_STATES = new Set(["created", "needs_setup", "setting_up"]);

function isNeedsSetup(p: ProjectEntity): boolean {
  return NEEDS_SETUP_STATES.has(p.state);
}

function stateIcon(state: string): string {
  if (NEEDS_SETUP_STATES.has(state)) return "🟠";
  switch (state) {
    case "live":
      return "🟢";
    case "warning":
      return "🟡";
    case "critical":
      return "🔴";
    default:
      return "⚪";
  }
}

/**
 * Sort: needs-setup first (alphabetical within), then everyone else
 * alphabetical. Stable enough for the picker; the user's eye is
 * already drawn to the 🟠 chip on needs-setup rows.
 */
export function sortProjectsForLink(
  projects: readonly ProjectEntity[],
): ProjectEntity[] {
  return [...projects].sort((a, b) => {
    const aSetup = isNeedsSetup(a);
    const bSetup = isNeedsSetup(b);
    if (aSetup !== bSetup) return aSetup ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function ProjectLinkSlot({
  spec,
  onPick,
  list = realListProjects,
  setLocalPath = realSetLocalPath,
  onOpenWebFlow,
  wizardState,
}: ProjectLinkSlotProps) {
  const livePayload = useWizard((s) => s.payload);
  const liveVerified = useWizard((s) => s.verified);

  const payload = wizardState ? wizardState.payload : livePayload;
  const verified = wizardState ? wizardState.verified : liveVerified;

  const path = useMemo<string | undefined>(() => {
    const hint = spec.optionsHint;
    if (hint && typeof hint.path === "string") return hint.path;
    return undefined;
  }, [spec.optionsHint]);

  const [projects, setProjects] = useState<readonly ProjectEntity[] | null>(
    null,
  );
  // Fetch existing projects on mount. Skip when the wizard is already
  // active (state A) — the picker won't render.
  useEffect(() => {
    if (payload) return;
    let cancelled = false;
    void list().then((rows) => {
      if (!cancelled) setProjects(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [payload, list]);

  // Latch — onPick fires exactly once when the wizard verifies, even
  // if the verified state re-fires (SSE replay).
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked) return;
    if (!payload) return;
    if (!verified) return;
    setPicked(true);
    onPick({
      kind: "project_link",
      projectId: payload.projectId,
    });
  }, [payload, verified, picked, onPick]);

  const handlePickExisting = useCallback(
    async (project: ProjectEntity) => {
      // Persist the local clone path so the next `findProjectByLocalPath`
      // probe resolves silently. Best-effort: a missing-directory or
      // store-write error doesn't block the slash dispatch — the
      // install can still proceed; we just won't auto-resolve next
      // time.
      if (path) {
        try {
          await setLocalPath(project.id, path);
        } catch {
          /* swallow — see comment above */
        }
      }
      onPick({
        kind: "project_link",
        projectId: project.id,
        name: project.name,
      });
    },
    [path, onPick, setLocalPath],
  );

  const openWebFlow = useCallback(() => {
    if (onOpenWebFlow) {
      onOpenWebFlow();
      return;
    }
    // openMainWindow brings the window forward AND navigates in one
    // shot. The web's /projects route reads the addPath query and
    // pre-fills the Add Project form.
    const target = path
      ? `projects?addPath=${encodeURIComponent(path)}`
      : "projects";
    void openMainWindow(target);
  }, [onOpenWebFlow, path]);

  // ── State A — wizard mid-flight ────────────────────────────────────────
  if (payload) {
    return (
      <div data-testid="project-link-slot-wizard">
        <PathBanner path={path} />
        <div
          className="rounded-md overflow-hidden"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            border: "1px solid var(--border)",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          <AddProjectWizard />
        </div>
        {verified ? (
          <div
            className="mt-2 text-[12px] flex items-center gap-2"
            style={{ color: "var(--text-subtle)" }}
          >
            <Loader2 size={12} className="animate-spin" /> Linking project…
          </div>
        ) : null}
      </div>
    );
  }

  // ── Loading state (state B/C boundary not yet decided) ─────────────────
  if (projects === null) {
    return (
      <div
        data-testid="project-link-slot-loading"
        className="text-[12px] py-4 text-center"
        style={{ color: "var(--text-faint)" }}
      >
        Loading projects…
      </div>
    );
  }

  // ── State B — existing projects list + "Add new" footer ────────────────
  if (projects.length > 0) {
    const sorted = sortProjectsForLink(projects);
    return (
      <div data-testid="project-link-slot-list">
        <PathBanner path={path} />
        <ul
          role="listbox"
          aria-label="Existing projects — pick one to link this folder to"
          className="max-h-[220px] overflow-auto rounded-md"
          style={{ background: "var(--bg-elev-2, var(--surface))" }}
        >
          {sorted.map((project) => (
            <li
              key={project.id}
              role="option"
              aria-selected={false}
              data-testid="project-link-row"
              data-state={project.state}
              onClick={() => void handlePickExisting(project)}
              className="palette-row px-3 py-2 cursor-pointer"
              style={{ fontSize: 13, color: "var(--text)" }}
            >
              <div className="flex items-center gap-2">
                <span>{stateIcon(project.state)}</span>
                <span className="flex-1 truncate">{project.name}</span>
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] tracking-[0.04em]"
                  style={{
                    background: "var(--bg-elev-3, transparent)",
                    color: "var(--text-subtle)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {project.state}
                </span>
              </div>
              <div
                className="text-[11px] font-mono mt-0.5"
                style={{ color: "var(--text-faint)" }}
              >
                {project.id.slice(0, 8)}
                {project.workspaceName ? ` · ${project.workspaceName}` : ""}
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={openWebFlow}
          data-testid="project-link-add-new"
          className="mt-2 w-full px-3 py-1.5 rounded-md text-[12px] flex items-center justify-center gap-1.5"
          style={{
            background: "var(--bg-elev-2, var(--surface))",
            color: "var(--text-subtle)",
            border: "1px dashed var(--border)",
          }}
        >
          <Plus size={12} strokeWidth={1.8} />
          Add a new project on web
        </button>
      </div>
    );
  }

  // ── State C — empty workspace, bridge to web ───────────────────────────
  return (
    <div data-testid="project-link-slot-bridge" className="py-3 px-3 text-center">
      <PathBanner path={path} />
      <div
        className="text-[12.5px] mb-3 leading-[1.55]"
        style={{ color: "var(--text-subtle)" }}
      >
        No projects in your workspace yet. Open
        InariWatch → Projects → <span style={{ color: "var(--text)" }}>Add Project</span>{" "}
        to create one — the wizard will continue here when it's ready.
      </div>
      <button
        type="button"
        onClick={openWebFlow}
        data-testid="project-link-open-web"
        className="px-3 py-1.5 rounded-md text-[12px] inline-flex items-center gap-1.5"
        style={{
          background: "var(--bg-elev-2, var(--surface))",
          color: "var(--text)",
          border: "1px solid var(--border)",
        }}
      >
        <ExternalLink size={12} strokeWidth={1.8} />
        Open Add Project on web
      </button>
    </div>
  );
}

function PathBanner({ path }: { path?: string }) {
  if (!path) return null;
  return (
    <div
      className="mb-2 text-[11px] tracking-[0.04em] font-mono px-2 py-1 rounded"
      style={{
        background: "var(--bg-elev-3, transparent)",
        color: "var(--text-subtle)",
        border: "1px solid var(--border)",
        display: "inline-block",
      }}
    >
      {path}
    </div>
  );
}
