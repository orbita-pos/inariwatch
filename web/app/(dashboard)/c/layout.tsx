/**
 * /c layout — Inari Live V1 Session 5.
 *
 * Splits the dashboard's main content area into:
 *   * Left: inbox sidebar (filter chips + grouped conversation list).
 *   * Right: the active conversation page (or empty/welcome state).
 *
 * The outer dashboard chrome (workspace switcher + nav rail) still
 * wraps this layout — see `(dashboard)/layout.tsx`. This is a *secondary*
 * sidebar, scoped to the chat-first surface only.
 *
 * The sidebar runs as a client component because it consumes the
 * workspace SSE stream to live-update on new conversations. The
 * server-rendered initial list keeps the first paint fast.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";

import { listConversations } from "@/lib/services/conversations.service";
import { getActiveOrgId } from "@/lib/workspace";
import { InboxSidebar } from "./components/inbox-sidebar";

export default async function ConversationsLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  const userId = (session.user as { id?: string }).id;
  if (!userId) redirect("/login");

  const workspaceId = await getActiveOrgId().catch(() => null);
  const initialConversations = await listConversations(
    { userId, workspaceId },
    { state: "all" },
  );

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: "280px 1fr" }}
    >
      <aside
        aria-label="Conversation inbox"
        className="border-r border-line bg-surface min-h-0 overflow-hidden"
      >
        <InboxSidebar initialConversations={initialConversations} />
      </aside>
      <main className="min-h-0 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}
