/**
 * Tier 0 handler — direct pattern_memory apply, no LLM.
 *
 * Source of truth for the cached patch is `remediation_sessions.file_changes`
 * from the most recent successful (`status='completed' AND
 * monitoring_status='passed'`) session for `(project_id, fingerprint)`. The
 * `pattern_memory` row is what made the classifier pick Tier 0; the patch
 * itself lives on the session row that originally wrote that pattern.
 *
 * The handler:
 *   1. Verifies the promotion gate one more time (defense-in-depth — caller
 *      should already have enforced it).
 *   2. Locates the donor session.
 *   3. Reads the current file contents from the head of the base branch.
 *      If they already contain the cached fix verbatim, the handler returns
 *      `apply_failed` so the caller can short-circuit to "already fixed"
 *      rather than push a no-op PR.
 *   4. Returns the cached `FileChange[]` so the existing remediate.ts push
 *      pipeline can apply it. No LLM is called.
 *
 * Failures are non-throwing: every miss returns `{ ok: false, skipped }` so
 * the caller can fall through to Tier 1 / Tier 2.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import * as gh from "@/lib/services/github-api";
import type { RemediationSession } from "@/lib/db/schema";
import type { PatternMatch } from "./pattern-memory";
import { meetsTier0PromotionGate } from "./tier-router";

export type FileChange = { path: string; content: string };

export type Tier0Result =
  | { ok: true; fileChanges: FileChange[]; donorSessionId: string }
  | { ok: false; skipped: "gate_failed" | "no_cached_diff" | "apply_failed" };

export type Tier0Context = {
  /** GitHub token for reading current file content. Reads only — writes go
   *  through the existing remediate.ts push pipeline. */
  githubToken: string;
  owner: string;
  repo: string;
  baseBranch: string;
  /** Alert fingerprint that drives donor-session lookup. Required: without it
   *  there is no way to identify the originating session. */
  fingerprint: string;
};

type DonorRow = {
  id: string;
  file_changes: unknown;
};

export async function runTier0(
  session: Pick<RemediationSession, "id" | "projectId" | "alertId" | "repo" | "baseBranch">,
  match: PatternMatch,
  ctx: Tier0Context,
): Promise<Tier0Result> {
  if (!meetsTier0PromotionGate(match)) {
    return { ok: false, skipped: "gate_failed" };
  }

  const donor = await loadDonorSession(session.projectId, ctx.fingerprint, session.id);
  if (!donor) return { ok: false, skipped: "no_cached_diff" };

  const cached = parseFileChanges(donor.file_changes);
  if (cached.length === 0) return { ok: false, skipped: "no_cached_diff" };

  const allAlreadyMatch = await everyFileAlreadyMatches(cached, ctx);
  if (allAlreadyMatch) return { ok: false, skipped: "apply_failed" };

  return { ok: true, fileChanges: cached, donorSessionId: donor.id };
}

async function loadDonorSession(
  projectId: string,
  fingerprint: string,
  excludeSessionId: string,
): Promise<DonorRow | null> {
  try {
    const res = await db.execute<DonorRow>(sql`
      SELECT id, file_changes
      FROM remediation_sessions
      WHERE project_id = ${projectId}::uuid
        AND fingerprint = ${fingerprint}
        AND status = 'completed'
        AND (monitoring_status = 'passed' OR monitoring_status IS NULL)
        AND file_changes IS NOT NULL
        AND id <> ${excludeSessionId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const rows = Array.isArray(res) ? res : ((res as { rows?: DonorRow[] }).rows ?? []);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function parseFileChanges(raw: unknown): FileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: FileChange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path === "string" && typeof r.content === "string" && r.path.length > 0) {
      out.push({ path: r.path, content: r.content });
    }
  }
  return out;
}

async function everyFileAlreadyMatches(
  files: FileChange[],
  ctx: Tier0Context,
): Promise<boolean> {
  for (const f of files) {
    let current: string | null;
    try {
      current = await gh.getFileContent(ctx.githubToken, ctx.owner, ctx.repo, f.path, ctx.baseBranch);
    } catch {
      return false;
    }
    if (current === null || current !== f.content) return false;
  }
  return true;
}
