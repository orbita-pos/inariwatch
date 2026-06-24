import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizations, organizationMembers, projects } from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import { isReplayV2Enabled } from "@/lib/feature-flags";
import { PlayerV2 } from "./player-v2";

export const dynamic = "force-dynamic";

/**
 * Replay V2 viewer. Server-side auth + feature flag gate, then the client
 * component fetches the manifest (signed R2 URLs) and drives playback.
 *
 * This route is DISTINCT from /recordings/[id] (which shows V1 substrate
 * recordings). When a recording has both a substrate row and a replay
 * session, Phase 3 will add a link between the two views.
 */
export default async function ReplayPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  // Pull the project owner alongside the session so the personal-workspace
  // auth branch (org-less project) can verify ownership in one round-trip.
  const [row] = await db
    .select({
      sessionId: replaySessions.sessionId,
      organizationId: replaySessions.organizationId,
      projectOwnerId: projects.userId,
    })
    .from(replaySessions)
    .leftJoin(projects, eq(projects.id, replaySessions.projectId))
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);

  if (!row) return notFound();

  // Two-axis feature flag (org OR user). Personal sessions resolve their
  // user axis from the project owner — that's the row we just joined.
  if (!isReplayV2Enabled({ organizationId: row.organizationId, userId: row.projectOwnerId })) {
    return notFound();
  }

  // Authorization branches:
  //   - Org session  → viewer must own the org OR be a member.
  //   - Personal session (organizationId IS NULL) → viewer must be the
  //     project owner. We trust `projects.user_id` (NOT NULL by schema)
  //     rather than `replay_sessions.user_id` (`onDelete: set null`) so
  //     a stale denormalized field can never grant access.
  if (row.organizationId) {
    const [access] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, organizations.id),
          eq(organizationMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(organizations.id, row.organizationId),
          or(eq(organizations.ownerId, userId), eq(organizationMembers.userId, userId)),
        ),
      )
      .limit(1);

    if (!access) return notFound();
  } else {
    if (row.projectOwnerId !== userId) return notFound();
  }

  return <PlayerV2 sessionId={row.sessionId} currentUserId={userId} />;
}
