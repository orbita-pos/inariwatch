import { DockConversation } from "@/screens/DockConversation";

/**
 * Pre-pivot, "idle" was a 4-section dashboard (input + repo status +
 * quick-actions grid + recent-activity feed). The 2026-05-07 chat-first
 * reframe deletes that pattern — the empty state IS the conversation
 * surface with zero messages, which `DockConversation` renders as the
 * centered command-palette tip ("Inari is your InariWatch command
 * palette."). The pure-slash refactor (Phase 3, 2026-05-15) tightened
 * the framing further: the empty-state copy now points at slash
 * commands rather than free-form questions.
 *
 * Keeping `DockIdle` as a thin wrapper rather than deleting it
 * preserves every caller (`MainWindow`, the `useChat.mode === "idle"`
 * branch, existing imports) without forcing a rename. The legacy
 * dashboard data (repo status, recent activity, index stats) lives
 * behind dedicated slash commands now (e.g. `/digest`).
 */
export function DockIdle() {
  return <DockConversation />;
}
