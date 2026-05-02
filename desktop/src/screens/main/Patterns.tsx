import { Layers, SlidersHorizontal } from "lucide-react";

import { ActionSquare, EmptyState, TopBar } from "@/components/ui";

/**
 * Patterns — `patterns.json` viewer with success / failure counts per
 * fingerprint. Sesión 12 owns the writer; the read-only surface lands
 * next session. Polished empty shell for now.
 */
export function MainPatterns() {
  return (
    <section data-testid="main-patterns" className="h-full flex flex-col">
      <TopBar
        testId="main-patterns-topbar"
        title="Patterns"
        meta="Procedural memory by fingerprint"
        actions={
          <ActionSquare ariaLabel="Display options" testId="patterns-action-display">
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          </ActionSquare>
        }
      />
      <div className="flex-1 flex items-center justify-center px-6">
        <EmptyState
          testId="patterns-empty"
          icon={Layers}
          headline="No patterns learned yet"
          helper="Each successful fix teaches Inari a pattern. Recurring fingerprints surface here with their success rate."
        />
      </div>
    </section>
  );
}
