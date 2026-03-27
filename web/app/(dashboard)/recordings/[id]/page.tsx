import { db } from "@/lib/db";
import { substrateRecordings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { RecordingViewer } from "./viewer";

export default async function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [recording] = await db
    .select()
    .from(substrateRecordings)
    .where(eq(substrateRecordings.recordingId, id))
    .limit(1);

  if (!recording) return notFound();

  const events = (recording.events as Record<string, unknown>[]) ?? [];
  const categories = (recording.categories as Record<string, number>) ?? {};

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
      />
    </div>
  );
}
