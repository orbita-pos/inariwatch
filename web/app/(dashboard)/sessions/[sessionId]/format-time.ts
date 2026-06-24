/**
 * Format milliseconds as "M:SS.mmm" for the scrubber display.
 * Separate file so the pure function is testable without pulling in React.
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00.000";
  const totalS = Math.floor(ms / 1000);
  const minutes = Math.floor(totalS / 60);
  const seconds = totalS % 60;
  const millis = Math.floor(ms % 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
