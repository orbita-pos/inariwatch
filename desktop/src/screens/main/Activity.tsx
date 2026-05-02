import { Activity, Filter, SlidersHorizontal } from "lucide-react";

import { ActionSquare, EmptyState, TopBar } from "@/components/ui";

/**
 * Activity — last-24h timeline of FsChange / ShellEvent / Replay events.
 * Sesión 19 wires the real data; this is the polished empty shell.
 */
export function MainActivity() {
  return (
    <section data-testid="main-activity" className="h-full flex flex-col">
      <TopBar
        testId="main-activity-topbar"
        title="Activity"
        meta="Last 24 hours of sensor events"
        actions={
          <>
            <ActionSquare ariaLabel="Filter activity" testId="activity-action-filter">
              <Filter className="h-3.5 w-3.5" aria-hidden />
            </ActionSquare>
            <ActionSquare ariaLabel="Display options" testId="activity-action-display">
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            </ActionSquare>
          </>
        }
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
