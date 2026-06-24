"use client";

import { useState, useTransition, useId } from "react";
import { Plus, Trash2, CalendarDays, Phone } from "lucide-react";
import { createSchedule, deleteSchedule, addSlot, removeSlot, createOverride, removeOverride } from "./on-call-actions";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Slot {
  id:        string;
  userId:    string;
  level:     number;
  userName:  string | null;
  userEmail: string;
  dayStart:  number;
  dayEnd:    number;
  hourStart: number;
  hourEnd:   number;
}

interface Override {
  id:        string;
  userId:    string;
  level:     number;
  startsAt:  string;
  endsAt:    string;
  userName:  string | null;
  userEmail: string;
}

interface Schedule {
  id:        string;
  name:      string;
  timezone:  string;
  slots:     Slot[];
  overrides?: Override[];
}

interface WorkspaceMember {
  userId: string;
  name:   string | null;
  email:  string;
}

interface OnCallSectionProps {
  projectId:           string;
  isAdmin:             boolean;
  schedules:           Schedule[];
  currentOnCallUserId: string | null;
  workspaceMembers:    WorkspaceMember[];
}

const TIMEZONE_OPTIONS = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

function formatDayRange(start: number, end: number) {
  if (start === end) return DAY_NAMES[start];
  return `${DAY_NAMES[start]}–${DAY_NAMES[end]}`;
}

function formatHourRange(start: number, end: number) {
  const fmt = (h: number) => `${h.toString().padStart(2, "0")}:00`;
  if (start === 0 && end === 23) return "All day";
  return `${fmt(start)}–${fmt(end)}`;
}

export function OnCallSection({
  projectId,
  isAdmin,
  schedules,
  currentOnCallUserId,
  workspaceMembers,
}: OnCallSectionProps) {
  const [showNewSchedule, setShowNewSchedule]   = useState(false);
  const [showNewSlot, setShowNewSlot]           = useState<string | null>(null);
  const [scheduleName, setScheduleName]         = useState("Primary rotation");
  const [timezone, setTimezone]                 = useState("UTC");
  const [slotUserId, setSlotUserId]             = useState(workspaceMembers[0]?.userId ?? "");
  const [slotLevel, setSlotLevel]               = useState(1);
  const [slotDayStart, setSlotDayStart]         = useState(1);
  const [slotDayEnd, setSlotDayEnd]             = useState(5);
  const [slotHourStart, setSlotHourStart]       = useState(0);
  const [slotHourEnd, setSlotHourEnd]           = useState(23);
  const [showOverrideForm, setShowOverrideForm] = useState<string | null>(null);
  const [overrideUserId, setOverrideUserId]     = useState(workspaceMembers[0]?.userId ?? "");
  const [overrideLevel, setOverrideLevel]       = useState(1);
  const [overrideStartsAt, setOverrideStartsAt] = useState("");
  const [overrideEndsAt, setOverrideEndsAt]     = useState("");
  const [error, setError]                       = useState("");
  const [isPending, startTransition]            = useTransition();

  const uid = useId();
  const ids = {
    schedName:    `${uid}-sched-name`,
    schedTz:      `${uid}-sched-tz`,
    slotMember:   `${uid}-slot-member`,
    slotLevel:    `${uid}-slot-level`,
    slotDayStart: `${uid}-slot-day-start`,
    slotDayEnd:   `${uid}-slot-day-end`,
    slotHrStart:  `${uid}-slot-hr-start`,
    slotHrEnd:    `${uid}-slot-hr-end`,
    ovMember:     `${uid}-ov-member`,
    ovLevel:      `${uid}-ov-level`,
    ovStarts:     `${uid}-ov-starts`,
    ovEnds:       `${uid}-ov-ends`,
    error:        `${uid}-error`,
  };

  const currentOnCall = workspaceMembers.find((m) => m.userId === currentOnCallUserId);

  const handleCreateSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await createSchedule(projectId, scheduleName, timezone);
      if (result.error) setError(result.error);
      else setShowNewSchedule(false);
    });
  };

  const handleDeleteSchedule = (scheduleId: string) => {
    startTransition(async () => {
      await deleteSchedule(projectId, scheduleId);
    });
  };

  const handleAddSlot = (scheduleId: string) => {
    setError("");
    startTransition(async () => {
      const result = await addSlot(
        projectId, scheduleId, slotUserId, slotLevel,
        slotDayStart, slotDayEnd, slotHourStart, slotHourEnd
      );
      if (result.error) setError(result.error);
      else setShowNewSlot(null);
    });
  };

  const handleRemoveSlot = (slotId: string) => {
    startTransition(async () => {
      await removeSlot(projectId, slotId);
    });
  };

  const handleAddOverride = (scheduleId: string) => {
    setError("");
    startTransition(async () => {
      const result = await createOverride(
        projectId, scheduleId, overrideUserId, overrideLevel, overrideStartsAt, overrideEndsAt
      );
      if (result.error) setError(result.error);
      else setShowOverrideForm(null);
    });
  };

  const handleRemoveOverride = (overrideId: string) => {
    startTransition(async () => {
      await removeOverride(projectId, overrideId);
    });
  };

  return (
    <section aria-labelledby="on-call-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="on-call-heading" className="text-xs font-medium uppercase tracking-widest text-fg-base/70">
          On-Call Schedule
        </h2>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowNewSchedule(!showNewSchedule)}
            aria-expanded={showNewSchedule}
            aria-controls="new-schedule-form"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-fg-base hover:border-line hover:text-fg-strong hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add schedule
          </button>
        )}
      </div>

      {/* Currently on-call */}
      {currentOnCall && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
          <Phone className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="text-sm text-emerald-700 dark:text-emerald-400">
            Currently on-call:{" "}
            <span className="font-medium text-emerald-800 dark:text-emerald-300">
              {currentOnCall.name ?? currentOnCall.email}
            </span>
          </span>
        </div>
      )}

      {/* Empty state */}
      {schedules.length === 0 && !showNewSchedule && (
        <div className="rounded-xl border border-line bg-surface px-5 py-6 text-center">
          <p className="text-sm text-fg-base/70">
            No on-call schedule configured. Create one to route alerts to the right person.
          </p>
        </div>
      )}

      {/* Schedule list */}
      {schedules.map((schedule) => {
        const schedHeadingId = `schedule-${schedule.id}`;
        return (
          <section
            key={schedule.id}
            aria-labelledby={schedHeadingId}
            className="mb-3 rounded-xl border border-line bg-surface overflow-hidden divide-y divide-line-subtle"
          >
            {/* Schedule header */}
            <div className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-2.5">
                <CalendarDays className="h-4 w-4 text-inari-accent shrink-0" aria-hidden="true" />
                <div>
                  <h3 id={schedHeadingId} className="text-sm font-medium text-fg-base">{schedule.name}</h3>
                  <p className="text-[11px] text-fg-base/70">{schedule.timezone}</p>
                </div>
              </div>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowNewSlot(showNewSlot === schedule.id ? null : schedule.id)}
                    aria-expanded={showNewSlot === schedule.id}
                    aria-label={`Add slot to ${schedule.name}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-fg-base/70 hover:text-fg-base hover:bg-surface-inner transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    Slot
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowOverrideForm(showOverrideForm === schedule.id ? null : schedule.id)}
                    aria-expanded={showOverrideForm === schedule.id}
                    aria-label={`Add override to ${schedule.name}`}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                  >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    Override
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSchedule(schedule.id)}
                    disabled={isPending}
                    aria-label={`Delete ${schedule.name} schedule`}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {/* Slots */}
            {schedule.slots.length > 0 ? (
              <ul className="divide-y divide-line-subtle">
                {schedule.slots.map((slot) => {
                  const slotLabel = slot.userName ?? slot.userEmail;
                  return (
                    <li key={slot.id} className="flex items-center gap-3 px-5 py-2.5">
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-dim text-[10px] font-bold text-fg-base/70"
                        aria-hidden="true"
                      >
                        {(slot.userName?.[0] ?? slot.userEmail[0]).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm text-fg-base">{slotLabel}</p>
                          <span className="rounded bg-surface-inner px-1.5 py-0.5 text-[10px] font-medium text-fg-base/70">
                            {slot.level === 1 ? "Primary" : "Secondary"}
                          </span>
                        </div>
                        <p className="text-[11px] text-fg-base/70">
                          {formatDayRange(slot.dayStart, slot.dayEnd)} · {formatHourRange(slot.hourStart, slot.hourEnd)}
                        </p>
                      </div>
                      {slot.userId === currentOnCallUserId && (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                          Active
                        </span>
                      )}
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => handleRemoveSlot(slot.id)}
                          disabled={isPending}
                          aria-label={`Remove ${slotLabel} from rotation`}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="px-5 py-4 text-center">
                <p className="text-xs text-fg-base/70">No slots. Add a member to start the rotation.</p>
              </div>
            )}

            {/* Add slot form */}
            {showNewSlot === schedule.id && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleAddSlot(schedule.id); }}
                aria-labelledby={`${uid}-slot-form-heading`}
                className="px-5 py-3 space-y-2.5"
              >
                <h4 id={`${uid}-slot-form-heading`} className="sr-only">Add slot to {schedule.name}</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <label htmlFor={ids.slotMember} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                      Team member
                    </label>
                    <select
                      id={ids.slotMember}
                      value={slotUserId}
                      onChange={(e) => setSlotUserId(e.target.value)}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
                    >
                      {workspaceMembers.map((m) => (
                        <option key={m.userId} value={m.userId}>{m.name ?? m.email}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={ids.slotLevel} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                      Level
                    </label>
                    <select
                      id={ids.slotLevel}
                      value={slotLevel}
                      onChange={(e) => setSlotLevel(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
                    >
                      <option value={1}>Primary</option>
                      <option value={2}>Secondary</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label htmlFor={ids.slotDayStart} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Day start</label>
                    <select
                      id={ids.slotDayStart}
                      value={slotDayStart}
                      onChange={(e) => setSlotDayStart(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                    >
                      {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={ids.slotDayEnd} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Day end</label>
                    <select
                      id={ids.slotDayEnd}
                      value={slotDayEnd}
                      onChange={(e) => setSlotDayEnd(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                    >
                      {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label htmlFor={ids.slotHrStart} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Hour start</label>
                    <select
                      id={ids.slotHrStart}
                      value={slotHourStart}
                      onChange={(e) => setSlotHourStart(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{i.toString().padStart(2, "0")}:00</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={ids.slotHrEnd} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Hour end</label>
                    <select
                      id={ids.slotHrEnd}
                      value={slotHourEnd}
                      onChange={(e) => setSlotHourEnd(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 disabled:opacity-60"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{i.toString().padStart(2, "0")}:00</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowNewSlot(null)}
                    disabled={isPending}
                    className="flex-1 rounded-lg border border-line-medium px-3 py-1.5 text-xs text-fg-base hover:text-fg-strong hover:border-line transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPending}
                    aria-busy={isPending}
                    className="flex-1 rounded-lg bg-inari-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-inari-accent/90 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                  >
                    {isPending ? "Adding…" : "Add slot"}
                  </button>
                </div>
              </form>
            )}

            {/* Overrides */}
            {schedule.overrides && schedule.overrides.length > 0 && (
              <div className="relative px-5 bg-surface-dim/30">
                <div className="absolute top-0 left-0 bottom-0 w-[3px] bg-amber-500/50" aria-hidden="true" />
                <ul className="divide-y divide-line-subtle">
                  {schedule.overrides.map((override) => {
                    const overrideLabel = override.userName ?? override.userEmail;
                    return (
                      <li key={override.id} className="flex items-center gap-3 py-2.5">
                        <div
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-[10px] font-bold text-amber-700 dark:text-amber-400"
                          aria-hidden="true"
                        >
                          {(override.userName?.[0] ?? override.userEmail[0]).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm text-fg-base">{overrideLabel}</p>
                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                              {override.level === 1 ? "Primary" : "Secondary"} Override
                            </span>
                          </div>
                          <p className="text-[11px] text-fg-base/70">
                            <time dateTime={override.startsAt}>
                              {new Date(override.startsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </time>
                            {" — "}
                            <time dateTime={override.endsAt}>
                              {new Date(override.endsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </time>
                          </p>
                        </div>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => handleRemoveOverride(override.id)}
                            disabled={isPending}
                            aria-label={`Remove override for ${overrideLabel}`}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-base/60 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Add override form */}
            {showOverrideForm === schedule.id && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleAddOverride(schedule.id); }}
                aria-labelledby={`${uid}-override-form-heading`}
                className="px-5 py-3 space-y-2.5 border-t border-line bg-surface-dim/10"
              >
                <h4 id={`${uid}-override-form-heading`} className="sr-only">Add override to {schedule.name}</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <label htmlFor={ids.ovMember} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                      Substitute member
                    </label>
                    <select
                      id={ids.ovMember}
                      value={overrideUserId}
                      onChange={(e) => setOverrideUserId(e.target.value)}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/20 transition-colors disabled:opacity-60"
                    >
                      {workspaceMembers.map((m) => (
                        <option key={m.userId} value={m.userId}>{m.name ?? m.email}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={ids.ovLevel} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
                      Level
                    </label>
                    <select
                      id={ids.ovLevel}
                      value={overrideLevel}
                      onChange={(e) => setOverrideLevel(Number(e.target.value))}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/20 transition-colors disabled:opacity-60"
                    >
                      <option value={1}>Primary</option>
                      <option value={2}>Secondary</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label htmlFor={ids.ovStarts} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Starts at</label>
                    <input
                      id={ids.ovStarts}
                      type="datetime-local"
                      value={overrideStartsAt}
                      onChange={(e) => setOverrideStartsAt(e.target.value)}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/20 disabled:opacity-60"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={ids.ovEnds} className="block text-[10px] font-medium uppercase tracking-wider text-fg-base/70">Ends at</label>
                    <input
                      id={ids.ovEnds}
                      type="datetime-local"
                      value={overrideEndsAt}
                      onChange={(e) => setOverrideEndsAt(e.target.value)}
                      disabled={isPending}
                      className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-amber-500/40 focus:outline-none focus:ring-1 focus:ring-amber-500/20 disabled:opacity-60"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOverrideForm(null)}
                    disabled={isPending}
                    className="flex-1 rounded-lg border border-line-medium px-3 py-1.5 text-xs text-fg-base hover:text-fg-strong hover:border-line transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPending}
                    aria-busy={isPending}
                    className="flex-1 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
                  >
                    {isPending ? "Adding…" : "Add override"}
                  </button>
                </div>
              </form>
            )}
          </section>
        );
      })}

      {/* New schedule form */}
      {showNewSchedule && isAdmin && (
        <form
          id="new-schedule-form"
          onSubmit={handleCreateSchedule}
          aria-labelledby={`${uid}-new-schedule-heading`}
          className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3"
        >
          <h3 id={`${uid}-new-schedule-heading`} className="sr-only">Create on-call schedule</h3>
          <div className="space-y-1.5">
            <label htmlFor={ids.schedName} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Schedule name
            </label>
            <input
              id={ids.schedName}
              type="text"
              value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
              placeholder="Primary rotation"
              required
              disabled={isPending}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder:text-fg-base/40 focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={ids.schedTz} className="block text-[11px] font-medium uppercase tracking-wider text-fg-base/70">
              Timezone
            </label>
            <select
              id={ids.schedTz}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={isPending}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none focus:ring-1 focus:ring-inari-accent/20 transition-colors disabled:opacity-60"
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          {error && (
            <p id={ids.error} role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-700 dark:text-red-400">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setShowNewSchedule(false); setError(""); }}
              disabled={isPending}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-fg-base hover:text-fg-strong hover:border-line transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              aria-busy={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-inari-accent/90 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inari-accent/50"
            >
              {isPending ? "Creating…" : "Create schedule"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
