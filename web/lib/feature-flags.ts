/**
 * Feature flags — env-var driven for now (no DB lookup needed).
 *
 * Pattern:
 *   FLAG_NAME=org_uuid_a,org_uuid_b   → enabled for those orgs only
 *   FLAG_NAME=*                       → enabled for everyone
 *   FLAG_NAME unset / empty           → disabled
 */

/**
 * Either-or allowlist check — `true` if the given id matches the env var
 * (comma-separated list or `*`). Used to gate on both org and user IDs
 * without callers having to care which one is set.
 */
function flagAllowsId(envValue: string | undefined, id: string | null | undefined): boolean {
  if (!envValue) return false;
  const allow = envValue.split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.includes("*")) return true;
  return id ? allow.includes(id) : false;
}

/**
 * Replay V2 (R2-backed block storage + multi-track timeline + AI chapters).
 * Phase 0 endpoints (`/api/replay/*`) require this to accept ingestion.
 *
 * Two-axis gate (mirrors isPreviewFixEnabled):
 *   - `REPLAY_V2_ORGS`  — comma-separated org UUIDs (or `*` for all)
 *   - `REPLAY_V2_USERS` — comma-separated user UUIDs (or `*` for all)
 *
 * A viewer is allowed if EITHER axis matches. Personal-workspace projects
 * (where `organizationId` is null) gate on the project owner's user ID.
 *
 * Legacy single-axis call site `isReplayV2Enabled(orgId)` keeps working —
 * it's treated as `{ organizationId: orgId, userId: null }`.
 */
export function isReplayV2Enabled(
  ctx: { organizationId?: string | null; userId?: string | null } | string | null | undefined,
): boolean {
  const organizationId = typeof ctx === "string" || ctx == null ? ctx ?? null : ctx.organizationId ?? null;
  const userId = typeof ctx === "string" || ctx == null ? null : ctx.userId ?? null;
  return (
    flagAllowsId(process.env.REPLAY_V2_ORGS, organizationId) ||
    flagAllowsId(process.env.REPLAY_V2_USERS, userId)
  );
}

/**
 * Preview Fix — two-tier visual preview of autonomous remediations.
 *
 * Two-axis gate:
 *   - `PREVIEW_FIX_ORGS`   — comma-separated org UUIDs (or `*` for all)
 *   - `PREVIEW_FIX_USERS`  — comma-separated user UUIDs (or `*` for all)
 *
 * A viewer is allowed if EITHER axis matches. This covers the two
 * workspace shapes we ship today:
 *   - Organization workspace (projects have a non-null `organizationId`)
 *   - Personal workspace (projects have `organizationId = null` — then we
 *     gate on the project owner's user ID)
 *
 * Kill switch: `PREVIEW_FIX_KILL=1` short-circuits everything (existing
 * previews still render via DB reads, only new creation is blocked).
 */
export function isPreviewFixEnabled(
  ctx: { organizationId?: string | null; userId?: string | null } | string | null | undefined,
): boolean {
  if (process.env.PREVIEW_FIX_KILL === "1") return false;
  // Accept the legacy signature (just an orgId) so pre-existing call sites
  // don't have to be touched atomically with this change.
  const organizationId = typeof ctx === "string" || ctx == null ? ctx ?? null : ctx.organizationId ?? null;
  const userId = typeof ctx === "string" || ctx == null ? null : ctx.userId ?? null;
  return (
    flagAllowsId(process.env.PREVIEW_FIX_ORGS, organizationId) ||
    flagAllowsId(process.env.PREVIEW_FIX_USERS, userId)
  );
}
