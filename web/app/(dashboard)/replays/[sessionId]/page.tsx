import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { replaySessions, organizations, organizationMembers } from "@/lib/db/schema";
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

  const [row] = await db
    .select({
      sessionId: replaySessions.sessionId,
      organizationId: replaySessions.organizationId,
    })
    .from(replaySessions)
    .where(eq(replaySessions.sessionId, sessionId))
    .limit(1);

  if (!row || !row.organizationId) return notFound();

  // Feature flag gate (keeps V2 invisible until the org is opted in)
  if (!isReplayV2Enabled(row.organizationId)) return notFound();

  // Authorization: user must own the org OR be a member
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

  return <PlayerV2 sessionId={row.sessionId} />;
}
