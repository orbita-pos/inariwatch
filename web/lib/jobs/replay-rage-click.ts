/**
 * Rage-click detection for replay sessions.
 *
 * A rage click is the user repeatedly clicking the same target in quick
 * succession — the classic "this button doesn't work, click click click"
 * frustration signal. Distinct from a dead click (which is a SINGLE
 * unresponsive click, see replay-dead-click.ts).
 *
 * Algorithm — sliding window per selector:
 *   1. Walk clicks in chronological order.
 *   2. Group consecutive clicks on the same selector that fall inside a
 *      `WINDOW_MS` window starting at the first click in the run.
 *   3. If the run has >= MIN_CLICKS clicks, emit one RageClick at the
 *      LAST click's timestamp with `count = run.length`.
 *   4. Once a run is closed, the next click starts a fresh window — even
 *      if it's still on the same selector. This naturally deduplicates
 *      overlapping windows (no rage emitted for "rage continuation").
 *
 * Pure function: takes events, returns rage clicks. No DB / network /
 * rrweb dependencies — trivially unit-testable.
 */

export interface RageClick {
  /** Wall-clock timestamp of the LAST click in the run. */
  timestamp: number;
  /** rrweb-captured CSS selector for the rage target. May be empty if rrweb
   *  couldn't compute one. */
  selector: string;
  /** Total number of clicks in the run (>= MIN_CLICKS). */
  count: number;
}

const WINDOW_MS = 1000;
const MIN_CLICKS = 3;

interface ClickEventShape {
  type: 3;
  timestamp: number;
  data: { source: 2; type: 2; selector?: string };
}

function isClick(e: unknown): e is ClickEventShape {
  if (!e || typeof e !== "object") return false;
  const ev = e as { type?: number; data?: { source?: number; type?: number } };
  return ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2;
}

/**
 * Detect rage clicks in a session's event stream.
 *
 * @param events  Mixed rrweb + custom event stream (any non-click event is ignored).
 * @returns Empty array when no rage detected. Otherwise one entry per run.
 */
export function detectRageClicks(events: unknown[]): RageClick[] {
  // Extract clicks once, sorted by timestamp. Some downstream callers
  // (the analyzer) merge blocks out of order, so we don't trust input order.
  const clicks: { ts: number; selector: string }[] = [];
  for (const e of events) {
    if (!isClick(e)) continue;
    clicks.push({ ts: e.timestamp, selector: e.data.selector ?? "" });
  }
  clicks.sort((a, b) => a.ts - b.ts);

  const out: RageClick[] = [];
  let i = 0;
  while (i < clicks.length) {
    const start = clicks[i];
    let j = i + 1;
    // Advance j while the next click is on the same selector AND within
    // WINDOW_MS of the FIRST click in this run. Anchoring on `start.ts`
    // (not the previous click) keeps the window length stable — three
    // clicks slowly creeping over 2s won't qualify.
    while (
      j < clicks.length &&
      clicks[j].selector === start.selector &&
      clicks[j].ts - start.ts <= WINDOW_MS
    ) {
      j++;
    }
    const runLength = j - i;
    if (runLength >= MIN_CLICKS) {
      const last = clicks[j - 1];
      out.push({ timestamp: last.ts, selector: start.selector, count: runLength });
    }
    // Always advance to j (one past the last click in the run) so a new
    // run starts fresh. Without this, a 5-click rage at the same selector
    // would emit overlapping detections from indices 0/1/2.
    i = j;
  }
  return out;
}
