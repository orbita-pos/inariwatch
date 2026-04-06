import { db } from "@/lib/db";
import { substrateRecordings, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { RecordingViewer } from "./viewer";

export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user) return notFound();

  const [recording] = await db
    .select()
    .from(substrateRecordings)
    .where(eq(substrateRecordings.recordingId, id))
    .limit(1);

  if (!recording) return notFound();

  // Verify the authenticated user owns the project associated with this recording
  if (recording.projectId) {
    const userId = (session.user as { id?: string }).id;
    const [proj] = await db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, recording.projectId), eq(projects.userId, userId!)))
      .limit(1);
    if (!proj) return notFound();
  }

  const events = (recording.events as Record<string, unknown>[]) ?? [];
  const categories = (recording.categories as Record<string, number>) ?? {};
  const uiEvents = (recording.uiEvents as unknown[]) ?? [];

  return (
    <div className="min-h-screen bg-page">
      <RecordingViewer
        recordingId={recording.recordingId}
        command={recording.command ?? "unknown"}
        runtime={recording.runtime ?? "node"}
        durationMs={recording.durationMs ?? 0}
        eventCount={recording.eventCount ?? 0}
        startedAt={recording.startedAt?.toISOString() ?? ""}
        events={events}
        categories={categories}
        context={recording.context}
        uiEvents={uiEvents}
      />
    </div>
  );
}
