/**
 * Code Intelligence v2 — Phase 3.1 sampling controls.
 *
 * The Phase 1.5 dispatcher runs both engines on every shadow call. Phase 3.1
 * adds three knobs so an operator can ramp shadow up/down without redeploy:
 *
 *   1. Global `SHADOW_SAMPLE_RATE` env var (default 1.0 = always shadow)
 *      — fraction of calls that get the v2 shadow. The remaining calls
 *      run only v1, exactly as if the engine flag were "off".
 *
 *   2. Per-workspace override `organizations.code_intel_v2_shadow_pct`
 *      (NULL = inherit the env, 0..100 overrides). Migration 0081.
 *
 *   3. Global kill switch `CODE_INTEL_V2_KILL_SHADOW=1` — forces ALL
 *      shadow calls to fall back to v1. Lets ops disable the harness
 *      instantly without flipping the engine flag (which would also
 *      cancel the per-workspace overrides operators have configured).
 *
 * Plus the timeout guard: if v2 takes more than 2× v1 wall-clock the
 * service abandons the v2 attempt, returns v1 immediately, and logs a
 * `v2_timed_out` row. Constants for the budget live here so tests and
 * the service share a single source of truth.
 */

import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { organizations } from "@/lib/db";
import { projects } from "@/lib/db";

// ── Env knobs ───────────────────────────────────────────────────────────────

const ENV_SAMPLE_RATE = "SHADOW_SAMPLE_RATE";
const ENV_KILL_SHADOW = "CODE_INTEL_V2_KILL_SHADOW";
const ENV_MIN_V2_BUDGET = "CODE_INTEL_V2_MIN_V2_BUDGET_MS";

/** Default shadow sample rate when the env var is unset. */
export const DEFAULT_SHADOW_SAMPLE_RATE = 1.0;

/**
 * Default minimum extra time (ms) that v2 gets after v1 finishes, even when
 * v1 was extremely fast. Without a floor a 1ms v1 would give v2 only 1ms
 * of additional headroom, which would constantly trip the slow guard and
 * skew the cutover metrics. Tests override via the env var.
 */
export const DEFAULT_MIN_V2_BUDGET_MS = 100;

/**
 * `true` when the operator has set the kill switch. Cheap (env-only) so
 * the dispatcher checks it before any DB roundtrip. Anything that parses
 * as truthy enables the switch — `1`, `true`, `yes`, `on`. The default
 * "" reads as off.
 */
export function isShadowKilled(): boolean {
  const raw = (process.env[ENV_KILL_SHADOW] ?? "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Global default sample rate from env. Clamped to [0, 1]. Anything not a
 * number (e.g. typo "0.50%") falls back to the default so a misconfigured
 * env var can never make shadow LESS predictable.
 */
export function resolveGlobalShadowRate(): number {
  const raw = process.env[ENV_SAMPLE_RATE];
  if (raw === undefined || raw === "") return DEFAULT_SHADOW_SAMPLE_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SHADOW_SAMPLE_RATE;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * The min budget (ms) that v2 gets after v1 finishes. Configurable via env
 * mostly for tests — production uses the default 100ms.
 */
export function resolveMinV2BudgetMs(): number {
  const raw = process.env[ENV_MIN_V2_BUDGET];
  if (raw === undefined || raw === "") return DEFAULT_MIN_V2_BUDGET_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_V2_BUDGET_MS;
  return n;
}

// ── Per-workspace override lookup ──────────────────────────────────────────

/**
 * Returns the workspace's pct override (0..100) or `null` when no override is
 * configured (or the project's organization is unknown). Resolves the project
 * → organization join in a single query. Caller is expected to convert the
 * returned int to a 0..1 rate.
 *
 * Per CLAUDE.md service-layer policy this lookup queries `projects` and
 * `organizations` directly — neither table is in the code-intelligence
 * lockdown allowlist surface, but both are public schema tables that the
 * sampling helper legitimately needs to read.
 */
export async function getWorkspaceShadowPct(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ pct: organizations.codeIntelV2ShadowPct })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.pct ?? null;
}

// ── Sampling decision ──────────────────────────────────────────────────────

/**
 * Test seam — production wiring uses `getWorkspaceShadowPct` directly. Tests
 * pass a stub that returns a deterministic value without touching the DB.
 */
export interface SamplingDeps {
  getWorkspaceShadowPct: (projectId: string) => Promise<number | null>;
  random: () => number;
}

const defaultDeps: SamplingDeps = {
  getWorkspaceShadowPct,
  random: Math.random,
};

/**
 * `true` when the dispatcher should run the v2 shadow for this call.
 *
 * Resolution order (cheapest first):
 *   1. Kill switch — `false`. Always.
 *   2. Per-workspace override — its pct decides.
 *   3. Global SHADOW_SAMPLE_RATE — its rate decides.
 *
 * The dice roll uses a uniform `[0, 1)` random — `rate=1.0` always returns
 * `true`, `rate=0` always returns `false`, `rate=0.5` ~50% of the time.
 */
export async function shouldShadowSample(
  projectId: string,
  deps: SamplingDeps = defaultDeps,
): Promise<boolean> {
  if (isShadowKilled()) return false;

  const workspacePct = await safeWorkspacePct(projectId, deps);
  const rate = workspacePct !== null ? workspacePct / 100 : resolveGlobalShadowRate();

  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return deps.random() < rate;
}

async function safeWorkspacePct(
  projectId: string,
  deps: SamplingDeps,
): Promise<number | null> {
  try {
    return await deps.getWorkspaceShadowPct(projectId);
  } catch {
    // Sampling decision must not fail a search call. Fall back to the
    // global env rate when the per-workspace lookup errors. The Phase 1.7
    // shadow log will still record the call regardless of which branch
    // we took.
    return null;
  }
}

// ── Timeout budget ─────────────────────────────────────────────────────────

/**
 * After v1 finishes, give v2 this much ADDITIONAL time before the slow
 * guard trips. Total v2 budget ≈ v1Duration + this value.
 *
 * Spec: "v2 budget = 2× v1 wall-clock". v2 ran in parallel for `v1Ms` and
 * we add `v1Ms` more — total ≈ 2× v1Ms. The floor is `MIN_V2_BUDGET_MS`
 * so an extremely fast v1 (e.g. 1ms) doesn't immediately starve v2 of
 * runtime, which would otherwise constantly trip the slow guard and
 * skew the cutover metrics.
 */
export function v2AdditionalBudgetMs(v1Ms: number): number {
  return Math.max(v1Ms, resolveMinV2BudgetMs());
}
