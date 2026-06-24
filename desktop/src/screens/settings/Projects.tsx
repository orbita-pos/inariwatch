// Inari Live V1 — Settings → Projects.
//
// Lists every project visible to the signed-in user across all their
// workspaces, with state pill + per-row action (Open in web / Resume
// setup) + an "+ Add project" CTA that deeplinks to the web dashboard.
//
// Sync pattern (Anthropic/Linear/Vercel-tier — invisible sync):
//   1. Mount fetch on tab open.
//   2. Stale-while-revalidate — last list stays visible while a fresh
//      fetch is in flight, then swaps in atomically.
//   3. Focus revalidation — debounced 500ms when the window regains
//      focus, covers ~80% of "just-added-on-web" cases without a
//      relay round-trip.
//   4. Network reconnect revalidation — `online` event triggers
//      refresh after a flaky connection.
//   5. 401 listener — re-pair flow flips the panel to "not signed in"
//      without reload (matches `Devices.tsx`).
//
// Deferred: real-time relay push (`project.created` / state-change
// events) wakes when `INARI_LIVE_RELAY_JWT_KEY` ships in sops.
// Smart polling fallback follows the relay rollout.

import { useCallback, useEffect, useMemo, useState } from "react";

import { errorToString } from "@/lib/errors";
import {
  CloudError,
  cloudAuthStatus,
  cloudProjectsList,
  EVT_AUTH_REQUIRED,
  type ProjectRow,
} from "@/lib/cloud-ipc";
import { openInBrowser } from "@/lib/inari-search-ipc";
import { StatusPill, type StatusPillVariant } from "@/components/ui";

import {
  GhostButton,
  Segmented,
  SettingsGroup,
  SettingsHeader,
} from "./primitives";

type ProjectFilter = "all" | "personal" | "workspaces";

const FILTER_OPTIONS: ReadonlyArray<{ value: ProjectFilter; label: string }> = [
  { value: "all",        label: "All" },
  { value: "personal",   label: "Personal" },
  { value: "workspaces", label: "Workspaces" },
];

// ── Types ──────────────────────────────────────────────────────────────

type LoadState = "loading" | "ready" | "not_connected" | "error";

interface PillSpec {
  variant: StatusPillVariant;
  label:   string;
}

interface ActionSpec {
  /** "open" → /projects/{slug}; "resume" → /projects/{slug}/setup. */
  kind:  "open" | "resume" | "none";
  label: string;
}

const HOST_LABEL: Record<string, string> = {
  vercel: "Vercel",
  manual: "Manual",
};

// ── State machine → UI mapping ─────────────────────────────────────────
//
// Mirrors the CHECK constraint in migration 0091. `created` /
// `setting_up` / `needs_setup` are surfaced as a single "Needs setup"
// pill so the user doesn't need to learn the internal state names.

function pillFor(state: string): PillSpec {
  switch (state) {
    case "live":
      return { variant: "success", label: "Live" };
    case "verified":
      return { variant: "accent",  label: "Verified" };
    case "prepared":
      return { variant: "warning", label: "Pending first event" };
    case "needs_setup":
    case "setting_up":
    case "created":
      return { variant: "warning", label: "Needs setup" };
    case "archived":
      return { variant: "neutral", label: "Archived" };
    default:
      return { variant: "neutral", label: state };
  }
}

function actionFor(state: string): ActionSpec {
  switch (state) {
    case "needs_setup":
    case "setting_up":
    case "created":
      return { kind: "resume", label: "Resume setup" };
    case "archived":
      return { kind: "none",   label: "" };
    default:
      return { kind: "open",   label: "Open in web" };
  }
}

// ── Component ──────────────────────────────────────────────────────────

export function SettingsProjects() {
  const [state, setState]       = useState<LoadState>("loading");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [apiUrl, setApiUrl]     = useState<string>("https://app.inariwatch.com");
  const [filter, setFilter]     = useState<ProjectFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return projects;
    if (filter === "personal") {
      return projects.filter((p) => p.workspaceName === "Personal");
    }
    return projects.filter((p) => p.workspaceName !== "Personal");
  }, [projects, filter]);

  // Mount fetch + cache the api_url for deeplinks. The api_url comes
  // from cloud auth status (whatever the user paired against — could be
  // staging) so we never hardcode the production host in deeplinks.
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await cloudProjectsList();
      setProjects(result.projects);
      setState("ready");
    } catch (err) {
      if (err instanceof CloudError && err.kind === "not_connected") {
        setState("not_connected");
        return;
      }
      setState("error");
      setError(errorToString(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      try {
        const status = await cloudAuthStatus();
        if (status.api_url) setApiUrl(status.api_url.replace(/\/+$/, ""));
      } catch {
        /* fall back to default — user can still see the list. */
      }
    })();
  }, [refresh]);

  // Focus revalidation. Debounced 500ms so a quick alt-tab roundtrip
  // doesn't fire two requests back-to-back.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 500);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  // Network reconnect revalidation — refetch when the user comes back
  // online after a flaky connection.
  useEffect(() => {
    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refresh]);

  // 401 listener — bearer invalidated server-side. Refresh flips to the
  // not_connected branch without reload. Mirrors `Devices.tsx`.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen(EVT_AUTH_REQUIRED, () => void refresh());
        if (cancelled) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        /* tauri runtime not present (tests) */
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  const onAction = useCallback(
    async (project: ProjectRow) => {
      const spec = actionFor(project.state);
      if (spec.kind === "none") return;
      const path =
        spec.kind === "resume"
          ? `/projects/${encodeURIComponent(project.slug)}/setup`
          : `/projects/${encodeURIComponent(project.slug)}`;
      try {
        await openInBrowser(`${apiUrl}${path}`);
      } catch (err) {
        setError(errorToString(err));
      }
    },
    [apiUrl],
  );

  const onAddProject = useCallback(async () => {
    try {
      await openInBrowser(`${apiUrl}/projects`);
    } catch (err) {
      setError(errorToString(err));
    }
  }, [apiUrl]);

  return (
    <section
      data-testid="settings-section-projects"
      className="flex flex-col"
    >
      <SettingsHeader
        title="Projects"
        description="Apps Inari Live is watching across your workspaces. Add new projects from the web dashboard — they'll appear here automatically."
      />

      <div className="mt-6" />

      {error ? (
        <div
          data-testid="projects-error"
          className="mt-4 px-3 py-2 text-[12.5px]"
          style={{
            border: "1px solid rgba(208,133,133,0.4)",
            background: "rgba(208,133,133,0.05)",
            color: "var(--danger)",
            borderRadius: 8,
          }}
        >
          {error}
        </div>
      ) : null}

      <SettingsGroup eyebrow="Connected projects">
        {state === "ready" && projects.length > 0 ? (
          <div className="mb-3">
            <Segmented<ProjectFilter>
              options={FILTER_OPTIONS}
              value={filter}
              onChange={setFilter}
              testId="projects-filter"
            />
          </div>
        ) : null}

        {state === "loading" ? (
          <p className="text-[12.5px] py-2" style={{ color: "var(--text-subtle)" }}>
            Loading projects…
          </p>
        ) : state === "not_connected" ? (
          <NotConnectedHint />
        ) : state === "error" ? (
          <ErrorHint onRetry={() => void refresh()} />
        ) : projects.length === 0 ? (
          <EmptyState onAdd={() => void onAddProject()} />
        ) : filtered.length === 0 ? (
          <FilteredEmpty filter={filter} />
        ) : (
          <ProjectListView
            projects={filtered}
            onAction={(p) => void onAction(p)}
          />
        )}

        {state === "ready" && projects.length > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void onAddProject()}
              data-testid="projects-add-cta"
              className="h-9 px-3.5 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-2 transition-transform active:scale-[0.98]"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
                border: "1px solid rgba(0,0,0,0.18)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 0 rgba(0,0,0,0.45)",
              }}
            >
              + Add project
            </button>
            <p className="mt-2 text-[11.5px]" style={{ color: "var(--text-subtle)" }}>
              Add Project happens on the web dashboard. New projects show up
              here as soon as the wizard finishes.
            </p>
          </div>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function ProjectListView({
  projects,
  onAction,
}: {
  projects: ProjectRow[];
  onAction: (project: ProjectRow) => void;
}) {
  return (
    <ul
      data-testid="projects-list"
      className="rounded-[10px] overflow-hidden"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      {projects.map((p, idx) => {
        const pill   = pillFor(p.state);
        const action = actionFor(p.state);
        const sub    = formatSubline(p);
        return (
          <li
            key={p.id}
            data-testid={`projects-row-${p.id}`}
            className="flex items-center justify-between px-4 py-3"
            style={{
              borderTop: idx === 0 ? "none" : "1px solid var(--border)",
            }}
          >
            <div className="flex flex-col min-w-0">
              <span
                className="text-[13px] truncate"
                style={{ color: "var(--text)", fontWeight: 500 }}
              >
                {p.name}
              </span>
              {sub ? (
                <span
                  className="text-[11.5px] truncate"
                  style={{ color: "var(--text-subtle)" }}
                >
                  {sub}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <StatusPill variant={pill.variant}>{pill.label}</StatusPill>
              {action.kind !== "none" ? (
                <GhostButton
                  onClick={() => onAction(p)}
                  testId={`projects-action-${p.id}`}
                >
                  {action.label}
                </GhostButton>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function NotConnectedHint() {
  return (
    <div
      className="px-4 py-6 text-center text-[12.5px] rounded-[10px]"
      data-testid="projects-not-connected"
      style={{
        border: "1px dashed var(--border-strong)",
        color: "var(--text-subtle)",
      }}
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
        Not signed in
      </div>
      Connect to InariWatch from Settings → Account to see your projects.
    </div>
  );
}

function ErrorHint({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="px-4 py-4 text-[12.5px] rounded-[10px]"
      style={{
        border: "1px solid rgba(208,133,133,0.4)",
        background: "rgba(208,133,133,0.05)",
        color: "var(--text-muted)",
      }}
    >
      <div style={{ color: "var(--danger)", marginBottom: 4 }}>
        Couldn&apos;t load projects.
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="text-[12px] underline"
        style={{ color: "var(--text)" }}
      >
        Retry
      </button>
    </div>
  );
}

function FilteredEmpty({ filter }: { filter: ProjectFilter }) {
  const label =
    filter === "personal"
      ? "personal projects"
      : filter === "workspaces"
        ? "workspace projects"
        : "projects";
  return (
    <div
      className="px-4 py-5 text-center text-[12.5px] rounded-[10px]"
      data-testid="projects-filter-empty"
      style={{
        border: "1px dashed var(--border-strong)",
        color: "var(--text-subtle)",
      }}
    >
      No {label} yet. Switch tab or add one from the web dashboard.
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="px-4 py-6 text-center text-[12.5px] rounded-[10px]"
      data-testid="projects-empty-state"
      style={{
        border: "1px dashed var(--border-strong)",
        color: "var(--text-subtle)",
      }}
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
        No projects yet
      </div>
      Add your first project on the web dashboard — it&apos;ll appear here
      automatically.
      <div className="mt-3">
        <button
          type="button"
          onClick={onAdd}
          data-testid="projects-add-empty"
          className="text-[12px] underline"
          style={{ color: "var(--text)" }}
        >
          + Add project on web
        </button>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatSubline(p: ProjectRow): string | null {
  const parts: string[] = [];
  if (p.workspaceName) parts.push(p.workspaceName);
  if (p.host) parts.push(HOST_LABEL[p.host] ?? p.host);
  if (p.lastActivityAt) parts.push(formatRelative(p.lastActivityAt));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Cheap relative-time formatter — same shape as Devices.tsx. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60)    return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)    return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)      return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30)       return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
