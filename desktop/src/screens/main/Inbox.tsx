import { Bell, Filter, Inbox, Search, SlidersHorizontal } from "lucide-react";

import { ActionSquare, EmptyState, TopBar } from "@/components/ui";

/**
 * Inbox — main shell. Sesión 19 wires the real alerts feed; until then this
 * surface ships a polished empty state so the dogfood window doesn't read
 * as broken on first run.
 *
 * Layout: TopBar (title + filter actions) → empty card.
 */
export function MainInbox() {
  return (
    <section data-testid="main-inbox" className="h-full flex flex-col">
      <TopBar
        testId="main-inbox-topbar"
        title="Inbox"
        meta="Active alerts will appear here"
        actions={
          <>
            <ActionSquare ariaLabel="Search inbox" testId="inbox-action-search">
              <Search className="h-3.5 w-3.5" aria-hidden />
            </ActionSquare>
            <ActionSquare ariaLabel="Filter" testId="inbox-action-filter">
              <Filter className="h-3.5 w-3.5" aria-hidden />
            </ActionSquare>
            <ActionSquare ariaLabel="Display options" testId="inbox-action-display">
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            </ActionSquare>
          </>
        }
      />
      <div className="flex-1 flex items-center justify-center px-6">
        <EmptyState
          testId="inbox-empty"
          icon={Inbox}
          headline="No alerts in flight"
          helper="Inari is watching your repo. When a sensor catches a real error, it lands here."
          cta={
            <span className="inline-flex items-center gap-2 text-[12px] text-[var(--text-subtle)]">
              <Bell className="h-3 w-3" aria-hidden />
              Notifications enabled
            </span>
          }
        />
      </div>
    </section>
  );
}
