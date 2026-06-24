/**
 * File-level locking for concurrent remediations.
 *
 * Prevents two remediation sessions from modifying the same files in the same repo.
 * Uses a DB table with TTL-based expiry so locks auto-release if the bot crashes.
 */

import { db, remediationLocks, remediationSessions } from "@/lib/db";
import { eq, and, lt, sql, count } from "drizzle-orm";

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOCK_WAIT_MS = 30_000; // max wait for a lock
const LOCK_POLL_MS = 5_000; // poll interval

// ── File Locks ──────────────────────────────────────────────────────────────

export async function acquireFileLocks(
  repoId: string,
  filePaths: string[],
  sessionId: string,
): Promise<{ acquired: string[]; conflicted: string[] }> {
  // Clean expired locks first
  await db.delete(remediationLocks).where(lt(remediationLocks.expiresAt, new Date()));

  const acquired: string[] = [];
  const conflicted: string[] = [];
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);

  for (const filePath of filePaths) {
    let locked = false;
    // Reset deadline per-file so cleaning expired locks on file N
    // doesn't eat into the budget for file N+1.
    let deadline = Date.now() + LOCK_WAIT_MS;

    while (Date.now() < deadline) {
      try {
        // Try INSERT — if PK exists, it'll fail (lock held).
        // NOTE: TOCTOU race window — between the expired-lock DELETE below and this
        // INSERT, another session could grab the same lock. This is acceptable because
        // the INSERT uses a DB-level unique constraint (repoId + filePath PK), so only
        // one session wins; the loser catches the error and retries.
        await db.insert(remediationLocks).values({
          repoId,
          filePath,
          sessionId,
          expiresAt,
        });
        acquired.push(filePath);
        locked = true;
        break;
      } catch {
        // Lock held by another session — check if it's ours or expired
        const [existing] = await db.select()
          .from(remediationLocks)
          .where(and(
            eq(remediationLocks.repoId, repoId),
            eq(remediationLocks.filePath, filePath),
          ))
          .limit(1);

        if (!existing) continue; // Race: lock was just released, retry

        if (existing.sessionId === sessionId) {
          // We already own this lock (resume scenario)
          acquired.push(filePath);
          locked = true;
          break;
        }

        if (new Date(existing.expiresAt) < new Date()) {
          // Expired — force-release and retry.
          // Race: another session may also delete+insert here; the PK constraint
          // on the INSERT above ensures only one winner.
          await db.delete(remediationLocks).where(and(
            eq(remediationLocks.repoId, repoId),
            eq(remediationLocks.filePath, filePath),
          ));
          // Reset deadline after cleaning an expired lock so we get a full
          // wait window for the retry attempt.
          deadline = Date.now() + LOCK_WAIT_MS;
          continue;
        }

        // Lock held by active session — wait
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      }
    }

    if (!locked) conflicted.push(filePath);
  }

  return { acquired, conflicted };
}

export async function releaseFileLocks(sessionId: string): Promise<void> {
  await db.delete(remediationLocks).where(eq(remediationLocks.sessionId, sessionId));
}

// ── Remediation Queue (concurrency + rate limiting) ─────────────────────────

const MAX_CONCURRENT_PER_PROJECT = 3;
const MAX_CONCURRENT_GLOBAL = 10;

/**
 * Check if a new remediation can start, or must be queued.
 * Returns true if the session can proceed immediately.
 */
export async function canStartRemediation(projectId: string): Promise<boolean> {
  // Sequential checks — TOCTOU race is acceptable here since this is a
  // soft concurrency limit, not a critical section. Avoids db.transaction()
  // which is unsupported by the neon-http driver.
  const activeStatuses = sql`${remediationSessions.status} IN ('analyzing', 'reading_code', 'generating_fix', 'pushing', 'awaiting_ci')`;

  const [projectCount] = await db
    .select({ n: count() })
    .from(remediationSessions)
    .where(and(eq(remediationSessions.projectId, projectId), activeStatuses));

  if ((projectCount?.n ?? 0) >= MAX_CONCURRENT_PER_PROJECT) return false;

  const [globalCount] = await db
    .select({ n: count() })
    .from(remediationSessions)
    .where(activeStatuses);

  return (globalCount?.n ?? 0) < MAX_CONCURRENT_GLOBAL;
}
