import { Activity } from "lucide-react";

import { EmptyState, TopBar } from "@/components/ui";

/**
 * Activity — last-24h timeline of FsChange / ShellEvent / Replay events.
 * Sesión 19 wires the real data; this is the polished empty shell.
 *
 * Filter / Display ActionSquares were removed (2026-05-01) per Jesús —
 * they had no onClick wired and confused users. Re-introduce only when
 * Activity has real events + a real filter store to drive them.
 */
export function MainActivity() {
  return (
    <section data-testid="main-activity" className="h-full flex flex-col">
      <TopBar
        testId="main-activity-topbar"
        title="Activity"
        meta="Last 24 hours of sensor events"
      />
      <div className="flex-1 flex items-center justify-center px-6">
        <EmptyState
          testId="activity-empty"
          icon={Activity}
          headline="No activity yet today"
          helper="FsChange, ShellEvent, and Replay events from the daemon stream here in real time."
        />
      </div>
    </section>
  );
}
