import { BookOpen, Search } from "lucide-react";

import { ActionSquare, EmptyState, TopBar } from "@/components/ui";

/**
 * Memory — `memory.md` preview + audit history. Sesión 11 wired the IPC
 * surface; the real renderer lands when the per-repo selector ships in
 * Sesión 19. This is the polished empty shell until then.
 */
export function MainMemory() {
  return (
    <section data-testid="main-memory" className="h-full flex flex-col">
      <TopBar
        testId="main-memory-topbar"
        title="Memory"
        meta="Notes, audits, and learned patterns"
        actions={
          <ActionSquare ariaLabel="Search memory" testId="memory-action-search">
            <Search className="h-3.5 w-3.5" aria-hidden />
          </ActionSquare>
        }
      />
      <div className="flex-1 flex items-center justify-center px-6">
        <EmptyState
          testId="memory-empty"
          icon={BookOpen}
          headline="No memory yet"
          helper="Inari stores per-repo notes, recent audits, and learned procedural patterns here. Open a repo to start building memory."
        />
      </div>
    </section>
  );
}
