/**
 * Code Intelligence v2 — engine selector.
 *
 * Single source of truth for "is v2 active for this call?". Read by the
 * service-layer `searchCode()` dispatcher.
 *
 * Phase 1.5 ships an env-var flag. Per-workspace overrides
 * (`organizations.code_intel_v2_enabled`) are deferred to Phase 3 cutover
 * prep — when shadow data is in, that's when per-workspace gating becomes
 * useful. For now, every workspace uses the same engine.
 *
 * Values:
 *   "off"    — only v1 runs. Default.
 *   "shadow" — v1 returned to caller, v2 ALSO runs and the results are
 *              logged to `code_intel_shadow_log` (Phase 1.7 widget reads it).
 *   "on"     — v2 returned to caller, v1 not invoked.
 *
 * Future-compat: callers MUST treat anything not in the literal set as "off".
 */

export type CodeIntelEngine = "off" | "shadow" | "on";

export const DEFAULT_ENGINE: CodeIntelEngine = "off";
const ENV_KEY = "CODE_INTEL_V2";

/**
 * Resolve the engine to use for an arbitrary `searchCode()` call. Pure —
 * does not perform any I/O. Phase 3 may add per-workspace overrides; the
 * signature already accepts a workspace context so consumers won't need
 * to change.
 */
export function resolveCodeIntelEngine(_ctx: {
  workspaceId?: string;
  projectId?: string;
} = {}): CodeIntelEngine {
  const raw = (process.env[ENV_KEY] ?? "").toLowerCase().trim();
  if (raw === "on") return "on";
  if (raw === "shadow") return "shadow";
  if (raw === "off" || raw === "") return DEFAULT_ENGINE;
  // Anything unexpected — fail closed to v1 so a typo can't accidentally
  // enable v2 in production.
  return DEFAULT_ENGINE;
}

export function isCodeIntelEngineActive(engine: CodeIntelEngine): boolean {
  return engine !== "off";
}
