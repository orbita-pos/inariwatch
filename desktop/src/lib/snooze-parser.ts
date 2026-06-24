/**
 * Flexible snooze-time parser — Inari Live V1 Session 5 (desktop copy).
 *
 * Parallel of `web/lib/conversations/snooze-parser.ts`. Pure module; no
 * Tauri / React deps. Both sides duplicate the parser intentionally —
 * the codebases live in separate packages and the parser is small
 * enough that a shared module isn't worth the build wiring complexity.
 *
 * Inputs:
 *   /snooze 2h | 30m | 7d   — relative duration
 *   /snooze 5pm | 9:30am    — clock time (today if future, else tomorrow)
 *   /snooze tomorrow [9am]  — relative day, optional clock
 *   /snooze monday [9am]    — day of week
 *   /snooze 2026-05-12      — ISO date (defaults 9 AM)
 */

export type SnoozeParseResult =
  | { until: Date }
  | { error: string };

const DOW = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

export function parseSnoozeUntil(input: string, now: Date = new Date()): SnoozeParseResult {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) {
    return { error: "Please provide a snooze duration. Try `2h`, `tomorrow`, `5pm`, or `monday`." };
  }

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

  const dayMatch = raw.match(/^(today|tomorrow)(?:\s+at\s+|\s+)?(.*)$/);
  if (dayMatch) {
    const [, dayWord, timeRest] = dayMatch;
    const base = new Date(now);
    if (dayWord === "tomorrow") base.setDate(base.getDate() + 1);
    return applyTimeOrDefault(base, timeRest);
  }

  const dowMatch = raw.match(/^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+|\s+)?(.*)$/);
  if (dowMatch) {
    const [, day, timeRest] = dowMatch;
    const targetDow = DOW.indexOf(day);
    const base = new Date(now);
    let delta = (targetDow - base.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    base.setDate(base.getDate() + delta);
    return applyTimeOrDefault(base, timeRest);
  }

  const clock = parseClockTime(raw);
  if (clock !== null) {
    const out = new Date(now);
    out.setHours(clock.h, clock.m, 0, 0);
    if (out.getTime() <= now.getTime()) {
      out.setDate(out.getDate() + 1);
    }
    return { until: out };
  }

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

interface Clock { h: number; m: number; }

function applyTimeOrDefault(base: Date, timeRest: string): SnoozeParseResult {
  const time = parseClockTime((timeRest ?? "").trim());
  if (time !== null) {
    base.setHours(time.h, time.m, 0, 0);
  } else {
    base.setHours(9, 0, 0, 0);
  }
  return { until: base };
}

function parseClockTime(input: string): Clock | null {
  if (!input) return null;
  const trimmed = input.trim();

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
