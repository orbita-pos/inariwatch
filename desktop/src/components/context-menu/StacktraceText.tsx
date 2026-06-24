import { useMemo } from "react";

import { segmentByLocations } from "@/lib/stacktrace";

import { StacktraceContextMenu } from "./StacktraceContextMenu";
import { StacktraceTooltip } from "./StacktraceTooltip";

export interface StacktraceTextProps {
  /** Raw text to scan + render. */
  text: string;
  /** Optional alert id forwarded into the prefill prompts. */
  alertId?: string;
  /** Stable test prefix so `__tests__` can drill into individual menus / tooltips. */
  testId?: string;
}

/**
 * Render `text` with each parsed stacktrace location wrapped in a
 * `<StacktraceContextMenu>` (right-click) + `<StacktraceTooltip>`
 * (hover). Plain prose between locations is rendered as-is.
 *
 * The component is purely a segmenter + binder; the actual menu /
 * tooltip components decide their own layout. It returns a `<span>`
 * sequence so callers (notably `<ChatMessage>`) can drop it inline
 * inside an existing `<p>`.
 */
export function StacktraceText({
  text,
  alertId,
  testId,
}: StacktraceTextProps) {
  const segments = useMemo(() => segmentByLocations(text), [text]);

  if (segments.length === 1 && segments[0]?.kind === "text") {
    // Fast path — no locations matched; render the plain text without
    // wrapping each character.
    return <>{segments[0].text}</>;
  }

  return (
    <>
      {segments.map((seg, idx) =>
        seg.kind === "text" ? (
          <span key={idx}>{seg.text}</span>
        ) : (
          <StacktraceContextMenu
            key={`${idx}-${seg.location.start}`}
            location={seg.location}
            alertId={alertId}
            testId={testId ? `${testId}-ctx-${idx}` : undefined}
          >
            <StacktraceTooltip
              location={seg.location}
              testId={testId ? `${testId}-tip-${idx}` : undefined}
            >
              <span
                data-testid={testId ? `${testId}-loc-${idx}` : undefined}
                className="underline decoration-dotted decoration-[var(--accent)]/60 underline-offset-2 cursor-pointer"
              >
                {seg.location.raw}
              </span>
            </StacktraceTooltip>
          </StacktraceContextMenu>
        ),
      )}
    </>
  );
}
