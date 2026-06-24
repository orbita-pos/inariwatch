/**
 * /c — inbox welcome / new conversation entry point.
 *
 * Empty-state landing for the chat-first surface. The sidebar (in
 * `layout.tsx`) holds the inbox; this pane shows the welcome card +
 * "Start a free conversation" form.
 */

import type { Metadata } from "next";
import { NewConversationForm } from "./components/new-conversation-form";

export const metadata: Metadata = { title: "Inbox" };

export default function ConversationsHome() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-8 py-12">
      <div className="max-w-md text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-base/50">
          Inbox
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg-strong">
          Pick a conversation, or start a new one
        </h1>
        <p className="mt-2 text-sm text-fg-base/60">
          Every alert opens a thread you can chat with. Resolve, snooze, or
          escalate from the same window — no separate alert page.
        </p>

        <div className="mt-8">
          <NewConversationForm />
        </div>
      </div>
    </div>
  );
}
