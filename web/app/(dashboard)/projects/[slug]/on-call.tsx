"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Clock, CalendarDays, Phone, CalendarClock } from "lucide-react";
import { createSchedule, deleteSchedule, addSlot, removeSlot, createOverride, removeOverride } from "./on-call-actions";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Slot {
  id: string;
  userId: string;
  level: number;
  userName: string | null;
  userEmail: string;
  dayStart: number;
  dayEnd: number;
  hourStart: number;
  hourEnd: number;
}

interface Override {
  id: string;
  userId: string;
  level: number;
  startsAt: string;
  endsAt: string;
  userName: string | null;
  userEmail: string;
}

interface Schedule {
  id: string;
  name: string;
  timezone: string;
  slots: Slot[];
  overrides?: Override[];
}

interface WorkspaceMember {
  userId: string;
  name: string | null;
  email: string;
}

interface OnCallSectionProps {
  projectId: string;
  isAdmin: boolean;
  schedules: Schedule[];
  currentOnCallUserId: string | null;
  workspaceMembers: WorkspaceMember[];
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
  const [showNewSchedule, setShowNewSchedule] = useState(false);
  const [showNewSlot, setShowNewSlot] = useState<string | null>(null);
  const [scheduleName, setScheduleName] = useState("Primary rotation");
  const [timezone, setTimezone] = useState("UTC");
  const [slotUserId, setSlotUserId] = useState(workspaceMembers[0]?.userId ?? "");
  const [slotLevel, setSlotLevel] = useState(1);
  const [slotDayStart, setSlotDayStart] = useState(1); // Monday
  const [slotDayEnd, setSlotDayEnd] = useState(5); // Friday
  const [slotHourStart, setSlotHourStart] = useState(0);
  const [slotHourEnd, setSlotHourEnd] = useState(23);
  
  const [showOverrideForm, setShowOverrideForm] = useState<string | null>(null);
  const [overrideUserId, setOverrideUserId] = useState(workspaceMembers[0]?.userId ?? "");
  const [overrideLevel, setOverrideLevel] = useState(1);
  const [overrideStartsAt, setOverrideStartsAt] = useState("");
  const [overrideEndsAt, setOverrideEndsAt] = useState("");

  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

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
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-widest text-zinc-500">
          On-Call Schedule
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowNewSchedule(!showNewSchedule)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-medium bg-transparent px-3 py-1.5 text-[12px] font-medium text-zinc-400 hover:border-zinc-600 hover:text-fg-base transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Add schedule
          </button>
        )}
      </div>

      {/* Currently on-call badge */}
      {currentOnCall && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-4 py-2.5">
          <Phone className="h-4 w-4 text-emerald-400" />
          <span className="text-sm text-emerald-400">
            Currently on-call:{" "}
            <span className="font-medium text-emerald-300">
              {currentOnCall.name ?? currentOnCall.email}
            </span>
          </span>
        </div>
      )}

      {schedules.length === 0 && !showNewSchedule && (
        <div className="rounded-xl border border-line bg-surface px-5 py-6 text-center">
          <p className="text-sm text-zinc-500">
            No on-call schedule configured. Create one to route alerts to the right person.
          </p>
        </div>
      )}

      {schedules.map((schedule) => (
        <div key={schedule.id} className="mb-3 rounded-xl border border-line bg-surface divide-y divide-line-subtle">
          {/* Schedule header */}
          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2.5">
              <CalendarDays className="h-4 w-4 text-inari-accent" />
              <div>
                <p className="text-sm font-medium text-fg-base">{schedule.name}</p>
                <p className="text-[11px] text-zinc-600">{schedule.timezone}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {isAdmin && (
                <>
                  <button
                    onClick={() => setShowNewSlot(showNewSlot === schedule.id ? null : schedule.id)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-500 hover:text-fg-base hover:bg-surface-inner transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    Slot
                  </button>
                  <button
                    onClick={() => handleDeleteSchedule(schedule.id)}
                    disabled={isPending}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Slots */}
          {schedule.slots.map((slot) => (
            <div key={slot.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-400">
                {(slot.userName?.[0] ?? slot.userEmail[0]).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-fg-base">{slot.userName ?? slot.userEmail}</p>
                  <span className="rounded bg-surface-inner px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    {slot.level === 1 ? "Primary" : "Secondary"}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-600">
                  {formatDayRange(slot.dayStart, slot.dayEnd)} · {formatHourRange(slot.hourStart, slot.hourEnd)}
                </p>
              </div>
              {slot.userId === currentOnCallUserId && (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-400">
                  Active
                </span>
              )}
              {isAdmin && (
                <button
                  onClick={() => handleRemoveSlot(slot.id)}
                  disabled={isPending}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}

          {schedule.slots.length === 0 && (
            <div className="px-5 py-4 text-center">
              <p className="text-xs text-zinc-600">No slots. Add a member to start the rotation.</p>
            </div>
          )}

          {/* Add slot form */}
          {showNewSlot === schedule.id && (
            <div className="px-5 py-3 space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    Team member
                  </label>
                  <select
                    value={slotUserId}
                    onChange={(e) => setSlotUserId(e.target.value)}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none transition-colors"
                  >
                    {workspaceMembers.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name ?? m.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    Level
                  </label>
                  <select
                    value={slotLevel}
                    onChange={(e) => setSlotLevel(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none transition-colors"
                  >
                    <option value={1}>Primary</option>
                    <option value={2}>Secondary</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Day start</label>
                  <select value={slotDayStart} onChange={(e) => setSlotDayStart(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none">
                    {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Day end</label>
                  <select value={slotDayEnd} onChange={(e) => setSlotDayEnd(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none">
                    {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Hour start</label>
                  <select value={slotHourStart} onChange={(e) => setSlotHourStart(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none">
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{i.toString().padStart(2, "0")}:00</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Hour end</label>
                  <select value={slotHourEnd} onChange={(e) => setSlotHourEnd(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-inari-accent/40 focus:outline-none">
                    {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{i.toString().padStart(2, "0")}:00</option>)}
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowNewSlot(null)}
                  className="flex-1 rounded-lg border border-line-medium px-3 py-1.5 text-xs text-zinc-400 hover:text-fg-base transition-colors">
                  Cancel
                </button>
                <button onClick={() => handleAddSlot(schedule.id)} disabled={isPending}
                  className="flex-1 rounded-lg bg-inari-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40">
                  {isPending ? "Adding..." : "Add slot"}
                </button>
              </div>
            </div>
          )}

          {/* Overrides */}
          {schedule.overrides && schedule.overrides.length > 0 && (
            <div className="border-t border-line bg-surface-dim/30 px-5 relative">
              <div className="absolute top-0 left-0 bottom-0 w-[#3px] bg-yellow-500/50"></div>
              {schedule.overrides.map((override) => (
                <div key={override.id} className="flex items-center gap-3 py-2.5 border-b border-line-subtle last:border-0 relative">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-yellow-500/10 text-[10px] font-bold text-yellow-500">
                    {(override.userName?.[0] ?? override.userEmail[0]).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-fg-base">{override.userName ?? override.userEmail}</p>
                      <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-500">
                        {override.level === 1 ? "Primary" : "Secondary"} Override
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-600">
                      {new Date(override.startsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} &mdash;{" "}
                      {new Date(override.endsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => handleRemoveOverride(override.id)}
                      disabled={isPending}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/[0.06] transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add override form */}
          {showOverrideForm === schedule.id && (
            <div className="px-5 py-3 space-y-2.5 border-t border-line bg-surface-dim/10">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    Substitute member
                  </label>
                  <select
                    value={overrideUserId}
                    onChange={(e) => setOverrideUserId(e.target.value)}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-yellow-500/40 focus:outline-none transition-colors"
                  >
                    {workspaceMembers.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name ?? m.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">
                    Level
                  </label>
                  <select
                    value={overrideLevel}
                    onChange={(e) => setOverrideLevel(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-yellow-500/40 focus:outline-none transition-colors"
                  >
                    <option value={1}>Primary</option>
                    <option value={2}>Secondary</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Starts At local time</label>
                  <input
                    type="datetime-local"
                    value={overrideStartsAt}
                    onChange={(e) => setOverrideStartsAt(e.target.value)}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-yellow-500/40 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Ends At local time</label>
                  <input
                    type="datetime-local"
                    value={overrideEndsAt}
                    onChange={(e) => setOverrideEndsAt(e.target.value)}
                    className="w-full rounded-lg border border-line-medium bg-surface-dim px-2 py-1.5 text-xs text-fg-base focus:border-yellow-500/40 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setShowOverrideForm(null)}
                  className="flex-1 rounded-lg border border-line-medium px-3 py-1.5 text-xs text-zinc-400 hover:text-fg-base transition-colors">
                  Cancel
                </button>
                <button onClick={() => handleAddOverride(schedule.id)} disabled={isPending}
                  className="flex-1 rounded-lg bg-yellow-500/10 text-yellow-500 px-3 py-1.5 text-xs font-medium hover:bg-yellow-500/20 transition-colors disabled:opacity-40 border border-yellow-500/20">
                  {isPending ? "Adding..." : "Add override"}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* New schedule form */}
      {showNewSchedule && isAdmin && (
        <form onSubmit={handleCreateSchedule} className="mt-3 rounded-xl border border-line bg-surface px-5 py-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Schedule name</label>
            <input
              type="text"
              value={scheduleName}
              onChange={(e) => setScheduleName(e.target.value)}
              placeholder="Primary rotation"
              required
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base placeholder-zinc-400 focus:border-inari-accent/40 focus:outline-none transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-lg border border-line-medium bg-surface-dim px-3 py-2 text-sm text-fg-base focus:border-inari-accent/40 focus:outline-none transition-colors"
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>
          {error && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-400">{error}</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowNewSchedule(false)}
              className="flex-1 rounded-lg border border-line-medium px-3 py-2 text-sm text-zinc-400 hover:text-fg-base transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={isPending}
              className="flex-1 rounded-lg bg-inari-accent px-3 py-2 text-sm font-medium text-white hover:bg-[#6D28D9] transition-colors disabled:opacity-40">
              {isPending ? "Creating..." : "Create schedule"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
