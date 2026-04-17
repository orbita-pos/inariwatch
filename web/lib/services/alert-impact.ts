/**
 * Alert impact aggregation — answers "how many users hit this exact error".
 *
 * Backs the FullTrace impact card on /alerts/[id] and (later) the
 * business-impact heuristic that drives autonomous-mode prioritization.
 *
 * Counts distinct sessions and distinct end-users that produced an alert
 * sharing the same `fingerprint`. Fingerprint is the canonical "is this the
 * same error" signal — same regression at runtime collapses to one row.
 *
 * Why fingerprint and not session_id alone:
 *   - One alert ↔ one session is the ingest case
 *   - One fingerprint ↔ N sessions is the audit case ("how many users
 *     hit the Stripe timeout this week"). The card answers the audit
 *     question; the deep link in the card uses the alert's own session_id.
 *
 * Returns null sessionsCount when the alert has no fingerprint (e.g.
 * deploy events, manual log calls). The UI hides the card in that case.
 */

import { db } from "@/lib/db";
import { alerts, replaySessions } from "@/lib/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export interface AlertImpact {
  /** Alert id we computed for. */
  alertId: string;
  /** This alert's session_id (nullable — most alerts created before SDK v0.8 don't have one). */
  sessionId: string | null;
  /** Fingerprint used for impact aggregation. Null = single-incident alert. */
  fingerprint: string | null;
  /** Distinct sessions that produced an alert with the same fingerprint. */
  sessionsAffected: number;
  /** Distinct end-users (replay_sessions.end_user_id) seen across those sessions. */
  usersAffected: number;
  /** Whether at least one of the affected sessions has a replay row in the DB
   *  (= the FullTrace deep link will actually render something). */
  hasFullTrace: boolean;
}

const EMPTY = (alertId: string, sessionId: string | null, fingerprint: string | null): AlertImpact => ({
  alertId,
  sessionId,
  fingerprint,
  sessionsAffected: 0,
  usersAffected: 0,
  hasFullTrace: false,
});

export async function getAlertImpact(alertId: string): Promise<AlertImpact> {
  const [alert] = await db
    .select({
      id: alerts.id,
      sessionId: alerts.sessionId,
      fingerprint: alerts.fingerprint,
      projectId: alerts.projectId,
    })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) return EMPTY(alertId, null, null);

  // Fingerprint is the aggregation key. Without it we can only report the
  // alert's own session — the rest of the card collapses to single-incident.
  if (!alert.fingerprint) {
    const hasFullTrace = alert.sessionId
      ? await sessionHasReplayRow(alert.sessionId)
      : false;
    return {
      alertId,
      sessionId: alert.sessionId,
      fingerprint: null,
      sessionsAffected: alert.sessionId ? 1 : 0,
      usersAffected: 0, // can't count without joining replay_sessions
      hasFullTrace,
    };
  }

  // Distinct sessions WHERE alerts.fingerprint = X AND alerts.session_id IS NOT NULL.
  // Scoped to the same project so cross-tenant fingerprint collisions don't
  // leak counts into another workspace's view.
  const [counts] = await db
    .select({
      sessionsAffected: sql<number>`COUNT(DISTINCT ${alerts.sessionId})::int`,
    })
    .from(alerts)
    .where(
      and(
        eq(alerts.fingerprint, alert.fingerprint),
        eq(alerts.projectId, alert.projectId),
        isNotNull(alerts.sessionId),
      ),
    );

  // Distinct end-users observed across those sessions. JOIN against
  // replay_sessions so we only count sessions that actually have an
  // identified user (Phase F end_user_id). emailHash counts are NOT
  // included — keep the metric "distinct identified users" not "distinct
  // anything we could possibly hash".
  const [userCount] = await db
    .select({
      usersAffected: sql<number>`COUNT(DISTINCT ${replaySessions.endUserId})::int`,
    })
    .from(replaySessions)
    .innerJoin(
      alerts,
      and(
        eq(alerts.sessionId, replaySessions.sessionId),
        eq(alerts.fingerprint, alert.fingerprint),
        eq(alerts.projectId, alert.projectId),
      ),
    )
    .where(isNotNull(replaySessions.endUserId));

  // hasFullTrace: at least one matching session has a replay row.
  // Cheap existence check via LIMIT 1.
  const [replayHit] = await db
    .select({ id: replaySessions.id })
    .from(replaySessions)
    .innerJoin(
      alerts,
      and(
        eq(alerts.sessionId, replaySessions.sessionId),
        eq(alerts.fingerprint, alert.fingerprint),
        eq(alerts.projectId, alert.projectId),
      ),
    )
    .limit(1);

  return {
    alertId,
    sessionId: alert.sessionId,
    fingerprint: alert.fingerprint,
    sessionsAffected: counts?.sessionsAffected ?? 0,
    usersAffected: userCount?.usersAffected ?? 0,
    hasFullTrace: !!replayHit,
  };
}

/** Cheap existence check — does this session_id resolve to a replay_sessions row? */
async function sessionHasReplayRow(sessionId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: replaySessions.id })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);
  return !!hit;
}
