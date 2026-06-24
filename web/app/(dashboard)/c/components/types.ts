/**
 * Wire types shared across the sidebar + conversation pane components.
 * Mirror the service layer's `ConversationListRow` shape verbatim so
 * the SSE stream, the GET /api/conversations response, and the React
 * client all agree on field names + nullability.
 */

import type { ConversationState } from "@/lib/conversations/state-machine";

export interface ConversationListRow {
  id: string;
  title: string;
  state: ConversationState;
  anchorAlertId: string | null;
  lastMessageAt: string;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  workspaceId: string | null;
  alertSeverity: string | null;
  alertSourceIntegrations: string[] | null;
  unreadHint: boolean;
}

export interface ConversationDetailMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  contentJson: { text?: string; meta?: Record<string, unknown> };
  toolCallId: string | null;
  createdAt: string;
  deviceId: string | null;
  prevMessageHash: string | null;
  messageHash: string | null;
}
