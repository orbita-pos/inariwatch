/**
 * Dead-click detection for replay sessions.
 *
 * A dead click is a click that produces no visible response from the page —
 * the user clicks, the DOM doesn't change, the URL doesn't change, nothing
 * happens. Common cause: a button with no onClick handler, a disabled
 * element rendered as enabled, an async handler that swallowed an error.
 *
 * Distinct from a rage click (a RUN of clicks, see replay-rage-click.ts).
 *
 * Algorithm — for each click, scan forward `WINDOW_MS`:
 *   1. Count rrweb DOM mutation events (type=3, data.source=0).
 *   2. Watch for any nav event (rrweb meta type=4 OR our custom `_kind: "nav"`).
 *   3. If mutations < `MIN_MUTATIONS` AND no nav fired → emit DeadClick.
 *
 * Exclusion — clicks immediately followed by a rage run (same selector,
 * within the rage window) are skipped here. Otherwise every rage on a
 * dead button would also produce N dead-click detections, double-counting
 * the same frustration. The analyzer wires this in by passing the rage
 * output into the `excludeTimestamps` set.
 *
 * Pure function: takes events, returns dead clicks.
 */

export interface DeadClick {
  /** Wall-clock timestamp of the click. */
  timestamp: number;
  /** rrweb-captured CSS selector. May be empty. */
  selector: string;
  /** Number of DOM mutations observed in the WINDOW_MS after the click. */
  mutationsAfter: number;
}

const WINDOW_MS = 3000;
const MIN_MUTATIONS = 5;

interface ClickEventShape {
  type: 3;
  timestamp: number;
  data: { source: 2; type: 2; selector?: string };
}

interface MutationEventShape {
  type: 3;
  timestamp: number;
  data: { source: 0 };
}

interface NavEventLike {
  timestamp: number;
}

function isClick(e: unknown): e is ClickEventShape {
  if (!e || typeof e !== "object") return false;
  const ev = e as { type?: number; data?: { source?: number; type?: number } };
  return ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2;
}

function isMutation(e: unknown): e is MutationEventShape {
  if (!e || typeof e !== "object") return false;
  const ev = e as { type?: number; data?: { source?: number } };
  return ev.type === 3 && ev.data?.source === 0;
}

function isNav(e: unknown): e is NavEventLike {
  if (!e || typeof e !== "object") return false;
  const ev = e as { type?: number; _kind?: string };
  // SDK custom nav (history.pushState patch) OR rrweb meta event.
  return ev._kind === "nav" || ev.type === 4;
}

/**
 * Detect dead clicks in a session's event stream.
 *
 * @param events  Mixed rrweb + custom event stream.
 * @param excludeTimestamps  Optional set of click timestamps to skip — used
 *   by the analyzer to avoid flagging rage-click runs as dead clicks too.
 * @returns Empty array when no dead clicks detected.
 */
export function detectDeadClicks(
  events: unknown[],
  excludeTimestamps: ReadonlySet<number> = new Set(),
): DeadClick[] {
  // Pre-extract sorted lists once. The dead-click loop below is O(C * (M+N))
  // worst case where C is click count, M mutation count, N nav count — but
  // because we sort and track binary-search-style cursors, the typical
  // pass is closer to O(C + M + N).
  const clicks: ClickEventShape[] = [];
  const mutationTs: number[] = [];
  const navTs: number[] = [];

  for (const e of events) {
    if (isClick(e)) clicks.push(e);
    else if (isMutation(e)) mutationTs.push(e.timestamp);
    else if (isNav(e)) navTs.push(e.timestamp);
  }
  mutationTs.sort((a, b) => a - b);
  navTs.sort((a, b) => a - b);

  const out: DeadClick[] = [];

  for (const click of clicks) {
    if (excludeTimestamps.has(click.timestamp)) continue;
    const start = click.timestamp;
    const end = start + WINDOW_MS;

    // Count mutations whose timestamp lies in (start, end]. Strict > so a
    // mutation event that shares the click's exact ts (rare, but happens
    // when both are flushed in the same rrweb tick) doesn't satisfy the
    // "did anything happen AFTER" question.
    let mutations = 0;
    for (const ts of mutationTs) {
      if (ts <= start) continue;
      if (ts > end) break;
      mutations++;
      if (mutations >= MIN_MUTATIONS) break;
    }

    if (mutations >= MIN_MUTATIONS) continue;

    // If the user navigated within the window, the click was clearly NOT
    // dead even if rrweb's mutation count was low (Next.js soft-nav often
    // batches the unmount before the next page renders).
    let navigated = false;
    for (const ts of navTs) {
      if (ts <= start) continue;
      if (ts > end) break;
      navigated = true;
      break;
    }
    if (navigated) continue;

    out.push({
      timestamp: start,
      selector: click.data.selector ?? "",
      mutationsAfter: mutations,
    });
  }

  return out;
}
