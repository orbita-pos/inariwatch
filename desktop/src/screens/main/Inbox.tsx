import { Bell, Inbox, Search } from "lucide-react";

import { ActionSquare, EmptyState, TopBar } from "@/components/ui";
import { useCommandPalette } from "@/lib/store/commandPalette";

/**
 * Inbox — main shell. Sesión 19 wires the real alerts feed; until then this
 * surface ships a polished empty state so the dogfood window doesn't read
 * as broken on first run.
 *
 * Layout: TopBar (title + Search action wired to command palette) → empty card.
 *
 * Filter / Display ActionSquares were removed (2026-05-01) per Jesús — they
 * had no onClick wired and confused users. Re-introduce when the inbox has
 * real alerts + a real filter store.
 */
export function MainInbox() {
  const openPalette = useCommandPalette((s) => s.openWithIntent);
  return (
    <section data-testid="main-inbox" className="h-full flex flex-col">
      <TopBar
        testId="main-inbox-topbar"
        title="Inbox"
        meta="Active alerts will appear here"
        actions={
          <ActionSquare
            ariaLabel="Search inbox"
            testId="inbox-action-search"
            onClick={() => openPalette("search")}
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
          </ActionSquare>
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
