import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db, remediationSessions } from "@/lib/db";
import { eq } from "drizzle-orm";
import { runRemediation } from "@/lib/ai/remediate";

const TERMINAL_STATES = ["completed", "failed", "cancelled", "proposing"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string })?.id;
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const [remSession] = await db
    .select()
    .from(remediationSessions)
    .where(eq(remediationSessions.id, sessionId))
    .limit(1);

  if (!remSession || remSession.userId !== userId) {
    return new Response("Not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      function emit(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }

      // If already done, send final state and close
      if (TERMINAL_STATES.includes(remSession.status)) {
        emit("restore", {
          status: remSession.status,
          steps: remSession.steps,
          prUrl: remSession.prUrl,
          prNumber: remSession.prNumber,
          error: remSession.error,
        });
        emit("done", {
          status: remSession.status,
          prUrl: remSession.prUrl,
          prNumber: remSession.prNumber,
          error: remSession.error,
        });
        controller.close();
        return;
      }

      // Send current state
      emit("restore", {
        status: remSession.status,
        steps: remSession.steps,
      });

      // Run the remediation engine — it calls emit() in real-time
      try {
        await runRemediation(sessionId, emit);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Engine error";
        emit("done", { status: "failed", error: msg });
      }

      if (!closed) {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
