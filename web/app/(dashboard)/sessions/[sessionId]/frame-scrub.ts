/**
 * Pure helpers for the frame-by-frame scrub keyboard shortcuts (`,` / `.`).
 * Extracted so the binary search can be unit-tested without spinning up
 * the rrweb player.
 *
 * Both helpers expect `timestamps` to be SORTED ASCENDING and DEDUPED.
 * The 1ms epsilon matters: without it a tap that lands exactly on an
 * event timestamp would "stick" — `prev` would return that same one and
 * `next` would skip past it inconsistently.
 */

/** Greatest timestamp strictly less than `currentMs`. -1 if none.
 *  Strict-less means standing exactly on a boundary advances backwards
 *  (the active boundary is skipped) instead of getting "stuck". */
export function findPrevEventIndex(timestamps: number[], currentMs: number): number {
  if (timestamps.length === 0) return -1;
  let lo = 0;
  let hi = timestamps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] < currentMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Smallest timestamp strictly greater than `currentMs`. -1 if none. */
export function findNextEventIndex(timestamps: number[], currentMs: number): number {
  if (timestamps.length === 0) return -1;
  let lo = 0;
  let hi = timestamps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] > currentMs) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}
