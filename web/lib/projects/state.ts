/**
 * Project wizard state machine — Inari Live V1 Session 3.
 *
 * DB-aware adapter on top of the pure rules in `state-machine.ts`. The
 * pure module enumerates valid edges; this one applies them with an
 * optimistic lock against `projects.state` and emits audit + event-bus
 * notifications.
 *
 * Use `transitionState({ projectId, from, to, ... })`. The helper:
 *   - rejects edges not listed in `VALID_TRANSITIONS`,
 *   - 404s when the project doesn't exist,
 *   - 409s when `from` doesn't match the row's current state (caller
 *     race detection — the wizard is concurrent with web clicks),
 *   - audit-logs success when a userId is provided,
 *   - publishes a `project.state.changed` event so SSE listeners pick
 *     it up.
 */

import { and, eq } from "drizzle-orm";

import { db, projects } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { publishProjectEvent } from "./event-bus";
import {
  PROJECT_STATES,
  isValidTransition,
  type ProjectState,
} from "./state-machine";

// Re-export the pure surface so existing callers can keep importing
// from `@/lib/projects/state` without caring about the split.
export { PROJECT_STATES, isValidTransition };
export type { ProjectState };

// ── Errors ──────────────────────────────────────────────────────────────────

export class ProjectStateError extends Error {
  constructor(
    public code: "not_found" | "stale_from_state" | "invalid_transition",
    message: string,
    public expected?: ProjectState,
    public actual?: ProjectState,
  ) {
    super(message);
    this.name = "ProjectStateError";
  }
}

// ── Service surface ─────────────────────────────────────────────────────────

export interface TransitionInput {
  projectId: string;
  /**
   * The state the caller believes the project is currently in. Required
   * because the wizard runs concurrently with web clicks — without an
   * optimistic lock the desktop's "install complete" could clobber the
   * web's "user archived". A mismatch surfaces as `stale_from_state`
   * and the caller can refresh + decide.
   */
  from: ProjectState;
  to: ProjectState;
  /** Audit log subject. NULL for system-driven transitions (cron, webhook). */
  userId?: string | null;
  /** Free-form metadata persisted on the audit row, not on the project. */
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  projectId: string;
  state: ProjectState;
}

/**
 * Atomically move a project to a new state. The single SQL UPDATE with
 * a `WHERE state = from` clause is the optimistic lock — if the row's
 * current state differs from `from` we update zero rows and surface
 * `stale_from_state`.
 *
 * Throws `ProjectStateError` rather than returning a discriminated
 * union: the wizard's HTTP routes already wrap exceptions into
 * NextResponse JSON errors, and a thrown error keeps the call sites
 * from silently ignoring failed transitions.
 */
export async function transitionState(input: TransitionInput): Promise<TransitionResult> {
  if (!isValidTransition(input.from, input.to)) {
    throw new ProjectStateError(
      "invalid_transition",
      `Cannot transition project state ${input.from} → ${input.to}`,
      input.from,
      input.to,
    );
  }

  const updated = await db
    .update(projects)
    .set({ state: input.to })
    .where(and(eq(projects.id, input.projectId), eq(projects.state, input.from)))
    .returning({ id: projects.id, state: projects.state });

  if (updated.length === 0) {
    // Either the row doesn't exist, or its current state isn't `from`.
    // Disambiguate so the caller can render the right error.
    const [current] = await db
      .select({ state: projects.state })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);

    if (!current) {
      throw new ProjectStateError("not_found", `Project ${input.projectId} not found`);
    }
    throw new ProjectStateError(
      "stale_from_state",
      `Project state is ${current.state}, expected ${input.from}`,
      input.from,
      current.state as ProjectState,
    );
  }

  // Audit + broadcast outside the SQL atomic — failures here must NOT
  // roll back a successful state change. Both have try/catch internally
  // (logAudit swallows / publishProjectEvent is in-process pubsub).
  // Audit only when we have a userId — webhook/cron-driven transitions
  // are intentionally anonymous (the action surface doesn't carry a
  // user identity), and `logAudit`'s schema requires non-null userId.
  if (input.userId) {
    await logAudit({
      userId:     input.userId,
      action:     "project.state.transitioned",
      resource:   "project",
      resourceId: input.projectId,
      metadata: {
        from: input.from,
        to:   input.to,
        ...input.metadata,
      },
    }).catch(() => undefined);
  }

  publishProjectEvent(input.projectId, {
    type:  "project.state.changed",
    state: input.to,
    at:    new Date().toISOString(),
  });

  return { projectId: input.projectId, state: input.to as ProjectState };
}

/**
 * Read-only snapshot used by routes that need the current state without
 * mutating it (e.g. the Add-Project page rendering "already wired up").
 * Returns `null` for missing projects so the caller can 404.
 */
export async function getProjectState(projectId: string): Promise<ProjectState | null> {
  const [row] = await db
    .select({ state: projects.state })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return (row?.state as ProjectState | undefined) ?? null;
}
