/**
 * Incident Correlation Engine
 *
 * Groups concurrent remediation sessions that stem from the same root cause
 * (e.g., a broken deploy triggering multiple errors). The first session becomes
 * the "leader" — if its fix resolves the others, they close automatically.
 */

import { db, remediationSessions, remediationIncidents, alerts } from "@/lib/db";
import { eq, and, gte, ne, inArray, sql } from "drizzle-orm";

const CORRELATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export interface CorrelationResult {
  /** If this session should wait for a leader to finish first */
  shouldWait: boolean;
  /** The incident this session belongs to (null if no correlation) */
  incidentId: string | null;
  /** The leader session ID (null if this IS the leader or no incident) */
  leaderSessionId: string | null;
  /** Number of related errors in this incident */
  relatedCount: number;
}

/**
 * Check if this session correlates with other active sessions.
 * Returns correlation info so the caller can decide to wait or proceed.
 */
export async function detectIncident(
  sessionId: string,
  projectId: string,
  alertId: string,
  filesToRead: string[],
): Promise<CorrelationResult> {
  const now = Date.now();
  const since = new Date(now - CORRELATION_WINDOW_MS);

  // Find other active sessions for this project in the correlation window
  const activeSessions = await db.select({
    id: remediationSessions.id,
    alertId: remediationSessions.alertId,
    status: remediationSessions.status,
    fileChanges: remediationSessions.fileChanges,
    createdAt: remediationSessions.createdAt,
  })
    .from(remediationSessions)
    .where(and(
      eq(remediationSessions.projectId, projectId),
      ne(remediationSessions.id, sessionId),
      gte(remediationSessions.createdAt, since),
      sql`${remediationSessions.status} NOT IN ('failed', 'cancelled', 'completed')`,
    ));

  if (activeSessions.length === 0) {
    return { shouldWait: false, incidentId: null, leaderSessionId: null, relatedCount: 0 };
  }

  // Check for file overlap (>50% of filesToRead shared with another session)
  let bestOverlap = 0;
  let leaderSession: typeof activeSessions[0] | null = null;

  for (const other of activeSessions) {
    const otherFiles = (other.fileChanges as { path: string }[] | null)?.map((f) => f.path) ?? [];
    if (otherFiles.length === 0 && filesToRead.length === 0) continue;

    const overlap = filesToRead.filter((f) => otherFiles.includes(f)).length;
    const overlapRatio = filesToRead.length > 0 ? overlap / filesToRead.length : 0;

    if (overlapRatio > bestOverlap) {
      bestOverlap = overlapRatio;
      leaderSession = other;
    }
  }

  // Also check time proximity — errors within 5 min window are likely correlated
  const timeCorrelated = activeSessions.filter((s) => {
    const diff = Math.abs(new Date(s.createdAt).getTime() - now);
    return diff < 5 * 60 * 1000;
  });

  const isCorrelated = bestOverlap >= 0.5 || timeCorrelated.length >= 2;

  if (!isCorrelated) {
    return { shouldWait: false, incidentId: null, leaderSessionId: null, relatedCount: 0 };
  }

  // Find or create incident
  const leader = leaderSession ?? timeCorrelated[0] ?? activeSessions[0];

  // Check if incident already exists for the leader
  const existingIncidents = await db.select()
    .from(remediationIncidents)
    .where(and(
      eq(remediationIncidents.projectId, projectId),
      eq(remediationIncidents.status, "open"),
    ))
    .limit(1);

  let incidentId: string;

  if (existingIncidents.length > 0) {
    incidentId = existingIncidents[0].id;
    // Add this session to the incident
    const currentIds = existingIncidents[0].sessionIds as string[];
    if (!currentIds.includes(sessionId)) {
      await db.update(remediationIncidents)
        .set({ sessionIds: [...currentIds, sessionId] })
        .where(eq(remediationIncidents.id, incidentId));
    }
  } else {
    // Create new incident
    const [incident] = await db.insert(remediationIncidents)
      .values({
        projectId,
        sessionIds: [leader.id, sessionId],
        leadSessionId: leader.id,
        status: "open",
      })
      .returning({ id: remediationIncidents.id });
    incidentId = incident.id;
  }

  const isLeader = leader.id === sessionId;

  return {
    shouldWait: !isLeader,
    incidentId,
    leaderSessionId: isLeader ? null : leader.id,
    relatedCount: activeSessions.length + 1,
  };
}

/**
 * After the leader session completes, check if its fix resolves the other sessions.
 * If the same fingerprint hasn't recurred, close the others as resolved_by_leader.
 */
export async function resolveIncidentFollowers(incidentId: string, leaderSucceeded: boolean): Promise<void> {
  if (!leaderSucceeded) return; // Leader failed — followers proceed normally

  const [incident] = await db.select()
    .from(remediationIncidents)
    .where(eq(remediationIncidents.id, incidentId))
    .limit(1);

  if (!incident) return;

  const followerIds = (incident.sessionIds as string[]).filter((id) => id !== incident.leadSessionId);
  if (followerIds.length === 0) return;

  // Mark followers as resolved by leader
  await db.update(remediationSessions)
    .set({
      status: "completed",
      error: `Resolved by incident leader (session ${incident.leadSessionId?.slice(0, 8)})`,
      updatedAt: new Date(),
    })
    .where(and(
      inArray(remediationSessions.id, followerIds),
      sql`${remediationSessions.status} IN ('analyzing', 'queued')`,
    ));

  await db.update(remediationIncidents)
    .set({ status: "resolved_by_leader" })
    .where(eq(remediationIncidents.id, incidentId));
}
