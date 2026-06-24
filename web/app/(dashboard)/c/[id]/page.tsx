/**
 * /c/[id] — single-conversation page.
 *
 * Server: fetches the conversation + alert anchor + initial messages
 * via the service layer (no HTTP roundtrip).
 *
 * Client: ConversationPane handles the chat surface + SSE merge.
 * ContextPanel renders Mode A (alert), Mode B (free), or Mode C
 * (resolved) based on the loaded data.
 */

import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { redirect, notFound } from "next/navigation";

import { authOptions } from "@/lib/auth";
import { getActiveOrgId } from "@/lib/workspace";
import { getConversation } from "@/lib/services/conversations.service";
import { ConversationPane } from "../components/conversation-pane";
import { ContextPanel } from "../components/context-panel";

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  const userId = (session.user as { id?: string }).id;
  if (!userId) redirect("/login");

  const workspaceId = await getActiveOrgId().catch(() => null);
  const result = await getConversation(id, { userId, workspaceId });
  if (!result) notFound();

  const initialMessages = result.messages.map((m) => ({
    id:               m.id,
    conversationId:   m.conversationId,
    role:             m.role as "user" | "assistant" | "tool" | "system",
    contentJson:      (m.contentJson as { text?: string; meta?: Record<string, unknown> }) ?? {},
    toolCallId:       m.toolCallId,
    createdAt:        m.createdAt.toISOString(),
    deviceId:         m.deviceId,
    prevMessageHash:  m.prevMessageHash,
    messageHash:      m.messageHash,
  }));

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: "1fr 320px" }}
    >
      <section className="min-h-0 flex flex-col">
        <ConversationPane
          conversationId={result.conversation.id}
          title={result.conversation.title}
          state={result.conversation.state as "active" | "snoozed" | "resolved" | "archived"}
          initialMessages={initialMessages}
        />
      </section>
      <aside
        aria-label="Conversation context"
        className="border-l border-line bg-surface min-h-0 overflow-hidden"
      >
        <ContextPanel
          conversation={{
            id:                result.conversation.id,
            title:             result.conversation.title,
            state:             result.conversation.state as "active" | "snoozed" | "resolved" | "archived",
            anchorAlertId:     result.conversation.anchorAlertId,
            snoozedUntil:      result.conversation.snoozedUntil?.toISOString() ?? null,
            resolvedAt:        result.conversation.resolvedAt?.toISOString() ?? null,
            resolutionSummary: result.conversation.resolutionSummary ?? null,
          }}
          alert={
            result.alert
              ? {
                  id: result.alert.id,
                  title: result.alert.title,
                  severity: result.alert.severity,
                  body: result.alert.body,
                  isRead: result.alert.isRead,
                  isResolved: result.alert.isResolved,
                  sourceIntegrations: result.alert.sourceIntegrations ?? [],
                  createdAt: result.alert.createdAt.toISOString(),
                }
              : null
          }
        />
      </aside>
    </div>
  );
}
