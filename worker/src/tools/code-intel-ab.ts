/**
 * Code Intelligence v2 — Phase 3.2 container-agent A/B router.
 *
 * Decides which tool set a remediation gets:
 *   - "v1": existing read_file / search_code / list_directory only
 *   - "v2": existing tools PLUS find_references / type_at / blast_radius
 *
 * Resolution (cheapest first):
 *   1. Hard kill — `CONTAINER_AGENT_AB_KILL_V2=1` forces every session to
 *      "v1" instantly, no DB lookup. Lets ops disable the experiment
 *      without restarting the worker or mutating each workspace.
 *   2. Per-workspace override — `organizations.code_intel_v2_agent_ab_pct`
 *      (NULL = inherit env, 0..100 = the percentage of remediations that
 *      get "v2"). Migration 0082 added the column.
 *   3. Global env — `CONTAINER_AGENT_AB_PCT` (0..100, default 0 = all v1).
 *
 * **Sticky per session.** The dice are seeded by a deterministic hash of
 * `sessionId`, so the same session always picks the same engine — even if
 * the worker crashes mid-flight and resumes. This guarantees the experiment
 * never sees an alert that touched both engines, which would corrupt the
 * cutover metrics.
 *
 * Decision telemetry (engine + workspacePct + source) is written to
 * `code_intel_remediation_ab` at the END of `runAgentJob` so a single row
 * captures the full lifecycle.
 */

import { db, organizations, projects } from "../db.js";
import { eq } from "drizzle-orm";

const ENV_AB_PCT = "CONTAINER_AGENT_AB_PCT";
const ENV_KILL_V2 = "CONTAINER_AGENT_AB_KILL_V2";

export type AgentEngine = "v1" | "v2";

export interface AgentEngineDecision {
  engine: AgentEngine;
  /** The per-workspace pct that informed the decision; NULL = used env. */
  workspacePct: number | null;
  /** Where the decision came from — useful for audit + tests. */
  source: "kill" | "workspace" | "global" | "default";
}

// ── Env resolution ─────────────────────────────────────────────────────────

export function isAgentAbKilled(): boolean {
  const raw = (process.env[ENV_KILL_V2] ?? "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Global env pct, clamped to [0, 100]. Anything that doesn't parse as a
 * number falls back to 0 (all v1) — typo protection that fails closed.
 */
export function resolveGlobalAgentAbPct(): number {
  const raw = process.env[ENV_AB_PCT];
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

// ── Workspace lookup ───────────────────────────────────────────────────────

/**
 * Looks up the project's workspace pct override. Returns null when:
 *   - projectId is null
 *   - the project row is missing
 *   - the workspace has no override (NULL column)
 *   - the lookup throws (Neon hiccup)
 *
 * Two simple queries instead of a JOIN so the unit tests can stub the
 * `db.select().from().where().limit()` chain without modeling innerJoin.
 */
export async function getWorkspaceAgentAbPct(
  projectId: string | null,
): Promise<number | null> {
  if (!projectId) return null;
  try {
    const [proj] = await db
      .select({ orgId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!proj?.orgId) return null;
    const [org] = await db
      .select({ pct: organizations.codeIntelV2AgentAbPct })
      .from(organizations)
      .where(eq(organizations.id, proj.orgId))
      .limit(1);
    return org?.pct ?? null;
  } catch {
    return null;
  }
}

// ── Sticky dice ────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash of the session id. Deterministic, collision-resistant
 * enough for a 100-bucket dice. No deps.
 *
 * Returns an integer in [0, 100). Compare against the pct: `dice < pct`
 * means the session lands in the v2 cohort.
 */
export function stickyDice(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

// ── Decision ───────────────────────────────────────────────────────────────

export interface ResolveAgentEngineOpts {
  sessionId: string;
  projectId: string | null;
  /** Test seam — production uses Math.random-free deterministic hashing. */
  workspaceLookup?: (projectId: string | null) => Promise<number | null>;
}

/**
 * Top-level resolver — call once per `runAgentJob` to fix the engine for
 * the whole session. Caller stores the result and uses it to (a) shape the
 * tool list and (b) stamp the telemetry row at the end.
 */
export async function resolveAgentEngine(
  opts: ResolveAgentEngineOpts,
): Promise<AgentEngineDecision> {
  if (isAgentAbKilled()) {
    return { engine: "v1", workspacePct: null, source: "kill" };
  }

  const lookup = opts.workspaceLookup ?? getWorkspaceAgentAbPct;
  const workspacePct = await lookup(opts.projectId);

  let pct: number;
  let source: AgentEngineDecision["source"];
  if (workspacePct !== null) {
    pct = workspacePct;
    source = "workspace";
  } else {
    pct = resolveGlobalAgentAbPct();
    source = pct === 0 ? "default" : "global";
  }

  // Trivial cases — skip the dice for clarity.
  if (pct <= 0) {
    return { engine: "v1", workspacePct, source };
  }
  if (pct >= 100) {
    return { engine: "v2", workspacePct, source };
  }

  const dice = stickyDice(opts.sessionId);
  return {
    engine: dice < pct ? "v2" : "v1",
    workspacePct,
    source,
  };
}
