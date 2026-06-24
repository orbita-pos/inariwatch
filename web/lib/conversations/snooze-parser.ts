/**
 * Flexible snooze-time parser — Inari Live V1 Session 5.
 *
 * Powers `/snooze <until>` so users can type natural-feeling shortcuts
 * without remembering ISO formats:
 *
 *   /snooze 2h           → +2 hours
 *   /snooze 30m          → +30 minutes
 *   /snooze 5pm          → today at 5pm (or tomorrow if past 5pm)
 *   /snooze 9:30am       → today at 9:30 (or tomorrow if past)
 *   /snooze tomorrow     → tomorrow 9:00 AM local
 *   /snooze monday       → next Monday 9:00 AM
 *   /snooze 2026-05-12   → ISO date at 9:00 AM
 *   /snooze 2026-05-12T17:00  → exact ISO timestamp
 *
 * Pure module: takes a `now` argument so tests can pin time. Returns
 * `{ until: Date }` on success or `{ error: string }` on bad input.
 *
 * Locale: the day-of-week shortcut assumes the server's TZ — fine for
 * V1 because Inari Live web sessions run on the user's browser TZ
 * passed in via header. V1.5 hardens this with a per-user TZ setting.
 */

export type SnoozeParseResult =
  | { until: Date }
  | { error: string };

const DOW = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

/**
 * Parse a user-typed snooze argument relative to `now`.
 *
 * Defaults to "+9am tomorrow" semantics for absolute words that don't
 * carry a time of day (matches Linear's Snooze behavior the users in
 * design study referenced).
 */
export function parseSnoozeUntil(input: string, now: Date = new Date()): SnoozeParseResult {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) {
    return { error: "Please provide a snooze duration. Try `2h`, `tomorrow`, `5pm`, or `monday`." };
  }

  // 1. Relative duration: 30m / 2h / 7d.
  const dur = raw.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks)$/);
  if (dur) {
    const value = Number.parseInt(dur[1], 10);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: "Duration must be a positive integer." };
    }
    const unit = dur[2];
    const ms =
      unit.startsWith("m") ? value * 60_000 :
      unit.startsWith("h") ? value * 3_600_000 :
      unit.startsWith("d") ? value * 86_400_000 :
      /* w */ value * 7 * 86_400_000;
    return { until: new Date(now.getTime() + ms) };
  }

  // 2. "tomorrow" / "today" with optional time.
  const dayMatch = raw.match(/^(today|tomorrow)(?:\s+at\s+|\s+)?(.*)$/);
  if (dayMatch) {
    const [, dayWord, timeRest] = dayMatch;
    const base = new Date(now);
    if (dayWord === "tomorrow") base.setDate(base.getDate() + 1);
    return applyTimeOrDefault(base, timeRest);
  }

  // 3. Day of week ("monday", "next friday").
  const dowMatch = raw.match(/^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+|\s+)?(.*)$/);
  if (dowMatch) {
    const [, day, timeRest] = dowMatch;
    const targetDow = DOW.indexOf(day);
    const base = new Date(now);
    let delta = (targetDow - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "monday" on a Monday means *next* Monday
    base.setDate(base.getDate() + delta);
    return applyTimeOrDefault(base, timeRest);
  }

  // 4. Bare clock time (5pm, 9:30am, 14:00) — today if future, else tomorrow.
  const clock = parseClockTime(raw);
  if (clock !== null) {
    const out = new Date(now);
    out.setHours(clock.h, clock.m, 0, 0);
    if (out.getTime() <= now.getTime()) {
      out.setDate(out.getDate() + 1);
    }
    return { until: out };
  }

  // 5. ISO timestamp / date.
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const out = new Date(parsed);
    if (out.getTime() <= now.getTime()) {
      return { error: "That time is already in the past." };
    }
    return { until: out };
  }

  return {
    error:
      "Couldn't parse that. Try a duration (`2h`, `30m`, `7d`), a clock time (`5pm`, `9:30am`), " +
      "a relative day (`tomorrow`, `monday`), or an ISO timestamp.",
  };
}

function applyTimeOrDefault(base: Date, timeRest: string): SnoozeParseResult {
  const time = parseClockTime((timeRest ?? "").trim());
  if (time !== null) {
    base.setHours(time.h, time.m, 0, 0);
  } else {
    base.setHours(9, 0, 0, 0); // Default 9am
  }
  return { until: base };
}

interface Clock {
  h: number;
  m: number;
}

/**
 * Recognise the small grammar of clock-time inputs:
 *
 *   `5pm`, `5 pm`, `5:30pm`, `5:30 pm`
 *   `9am`, `9:30am`
 *   `14:00`, `9:00`, `09:00`
 *
 * Returns null when the string isn't a clock time so the caller can
 * fall through to ISO parsing.
 */
function parseClockTime(input: string): Clock | null {
  if (!input) return null;
  const trimmed = input.trim();

  // 12h with am/pm.
  const m12 = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (m12) {
    let h = Number.parseInt(m12[1], 10);
    const mins = m12[2] ? Number.parseInt(m12[2], 10) : 0;
    const meridiem = m12[3].toLowerCase();
    if (h < 1 || h > 12) return null;
    if (mins < 0 || mins > 59) return null;
    if (meridiem === "pm" && h !== 12) h += 12;
    if (meridiem === "am" && h === 12) h = 0;
    return { h, m: mins };
  }

  // 24h with explicit colon.
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Number.parseInt(m24[1], 10);
    const mins = Number.parseInt(m24[2], 10);
    if (h < 0 || h > 23) return null;
    if (mins < 0 || mins > 59) return null;
    return { h, m: mins };
  }

  return null;
}
