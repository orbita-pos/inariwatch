"use client";

import { useState, useMemo, useCallback } from "react";
import { SessionPlayer } from "./session-player";

type EventKind = {
  type: string;
  [key: string]: unknown;
};

type RecordingEvent = {
  seq: number;
  timestamp_ns?: number;
  parent_seq?: number | null;
  kind: EventKind;
};

const CATEGORY_MAP: Record<string, string> = {
  HttpRequest: "http", HttpResponse: "http",
  DbQuery: "db",
  FileRead: "fs", FileWrite: "fs",
  DnsResolve: "dns",
  TimeNow: "time", TimeHrtime: "time",
  RandomFloat: "random", RandomBytes: "random",
  Exception: "exception",
  ProcessStart: "process",
  Marker: "marker",
};

const BADGE_STYLES: Record<string, string> = {
  http:      "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  db:        "bg-purple-500/10 text-purple-700 dark:text-purple-400",
  fs:        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  time:      "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  random:    "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  dns:       "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
  process:   "bg-surface-dim text-fg-base/60",
  exception: "bg-red-500/10 text-red-700 dark:text-red-400",
  marker:    "bg-surface-dim text-fg-base/50",
};

const DOT_COLORS: Record<string, string> = {
  http: "bg-blue-400", db: "bg-purple-400", fs: "bg-emerald-400",
  time: "bg-amber-400", random: "bg-amber-400", dns: "bg-cyan-400",
  process: "bg-fg-base/40", exception: "bg-red-400", marker: "bg-fg-base/30",
};

function getCategory(event: RecordingEvent): string {
  return CATEGORY_MAP[event.kind.type] ?? "marker";
}

function getSummary(event: RecordingEvent): string {
  const k = event.kind;
  switch (k.type) {
    case "HttpRequest": return `${k.method} ${k.url}`;
    case "HttpResponse": return `${k.status} (${k.duration_ms}ms)`;
    case "DbQuery": return `${String(k.query ?? "").slice(0, 80)}`;
    case "FileRead": return `read ${k.path}`;
    case "FileWrite": return `write ${k.path}`;
    case "DnsResolve": return `resolve ${k.hostname}`;
    case "Exception": return `${k.name}: ${String(k.message ?? "").slice(0, 80)}`;
    case "ProcessStart": return `${k.command}`;
    case "TimeNow": return `${k.value}ms`;
    case "Marker": return `${k.label ?? "marker"}`;
    default: return k.type;
  }
}

function formatTime(ns: number | undefined, baseNs: number): string {
  if (!ns) return "0ms";
  const ms = (ns - baseNs) / 1_000_000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type ViewerTab = "io" | "session" | "combined";

interface ViewerProps {
  recordingId: string;
  command: string;
  runtime: string;
  durationMs: number;
  eventCount: number;
  startedAt: string;
  events: Record<string, unknown>[];
  categories: Record<string, number>;
  context: string | null;
  uiEvents?: unknown[];
}

export function RecordingViewer(props: ViewerProps) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const hasUI = (props.uiEvents?.length ?? 0) > 0;
  const [activeTab, setActiveTab] = useState<ViewerTab>(hasUI ? "combined" : "io");
  const handleTimeChange = useCallback((_timeMs: number) => {
    // Future: auto-scroll I/O event list to matching timestamp
  }, []);

  const events = props.events as unknown as RecordingEvent[];
  const baseNs = events[0]?.timestamp_ns ?? 0;

  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    events.forEach((e) => cats.add(getCategory(e as RecordingEvent)));
    return Array.from(cats).sort();
  }, [events]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const ev = e as RecordingEvent;
      const cat = getCategory(ev);
      const catMatch = activeCategory === "all" || cat === activeCategory;
      const textMatch = !search || getSummary(ev).toLowerCase().includes(search.toLowerCase());
      return catMatch && textMatch;
    });
  }, [events, activeCategory, search]);

  const selectedEvent = events.find((e) => (e as RecordingEvent).seq === selectedSeq) as RecordingEvent | undefined;

  const statCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    events.forEach((e) => {
      const cat = getCategory(e as RecordingEvent);
      counts[cat] = (counts[cat] ?? 0) + 1;
    });
    return counts;
  }, [events]);

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="bg-surface border-b border-line px-8 py-5">
        <h1 className="text-lg font-semibold text-fg-strong">
          <span className="text-inari-accent">Recording</span> Inspector
        </h1>
        <div className="flex gap-6 mt-2 text-sm text-fg-base/60 flex-wrap">
          <span><strong className="text-fg-base">ID:</strong> {props.recordingId}</span>
          <span><strong className="text-fg-base">Command:</strong> {props.command}</span>
          <span><strong className="text-fg-base">Runtime:</strong> {props.runtime}</span>
          <span><strong className="text-fg-base">Duration:</strong> {props.durationMs}ms</span>
          <span><strong className="text-fg-base">Events:</strong> {props.eventCount}</span>
        </div>
      </div>

      {/* Tabs (only show if UI events exist) */}
      {hasUI && (
        <div className="flex gap-0 px-8 bg-surface border-b border-line">
          {([
            { id: "io" as const, label: "I/O Events" },
            { id: "session" as const, label: "Session Replay" },
            { id: "combined" as const, label: "Combined" },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-inari-accent text-inari-accent"
                  : "border-transparent text-fg-base/60 hover:text-fg-base"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Session Replay (full-width) */}
      {activeTab === "session" && hasUI && (
        <div className="px-8 py-4">
          <SessionPlayer events={props.uiEvents!} onTimeChange={handleTimeChange} />
        </div>
      )}

      {/* Combined: Session Replay (top) + I/O Events (bottom) */}
      {activeTab === "combined" && hasUI && (
        <div className="px-8 py-4 border-b border-line">
          <SessionPlayer events={props.uiEvents!} onTimeChange={handleTimeChange} />
        </div>
      )}

      {/* Controls (shown for I/O and Combined tabs) */}
      <div className={`flex gap-2 px-8 py-3 bg-surface-inner border-b border-line flex-wrap items-center ${activeTab === "session" ? "hidden" : ""}`}>
        <input
          type="text"
          placeholder="Search events..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-surface border border-line rounded-md px-3 py-1.5 text-sm text-fg-base w-60 focus:outline-none focus:border-inari-accent"
        />
        <button
          type="button"
          onClick={() => setActiveCategory("all")}
          aria-pressed={activeCategory === "all"}
          className={`text-xs px-3 py-1 rounded-md border transition-colors ${activeCategory === "all" ? "bg-inari-accent border-inari-accent text-white" : "border-line text-fg-base/60 hover:text-fg-base"}`}
        >
          All
        </button>
        {allCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            aria-pressed={activeCategory === cat}
            className={`text-xs px-3 py-1 rounded-md border transition-colors ${activeCategory === cat ? "bg-inari-accent border-inari-accent text-white" : "border-line text-fg-base/60 hover:text-fg-base"}`}
          >
            {cat} ({statCounts[cat] ?? 0})
          </button>
        ))}
      </div>

      {/* Stats (hidden on session-only tab) */}
      <div className={`flex gap-3 px-8 py-3 flex-wrap ${activeTab === "session" ? "hidden" : ""}`}>
        {Object.entries(statCounts).map(([cat, count]) => (
          <div key={cat} className="bg-surface border border-line rounded-lg px-4 py-2">
            <span className="text-xl font-bold text-fg-strong">{count}</span>
            <span className="text-xs text-fg-base/60 uppercase ml-2">{cat}</span>
          </div>
        ))}
      </div>

      {/* Timeline bar (hidden on session-only tab) */}
      <div className={`relative mx-8 h-1 bg-surface-dim rounded-full mb-4 ${activeTab === "session" ? "hidden" : ""}`}>
        {events.map((e) => {
          const ev = e as RecordingEvent;
          const cat = getCategory(ev);
          const pct = props.durationMs > 0 && ev.timestamp_ns
            ? ((ev.timestamp_ns - baseNs) / 1_000_000 / props.durationMs) * 100
            : 0;
          return (
            <div
              key={ev.seq}
              role="button"
              tabIndex={0}
              aria-label={`Event #${ev.seq}: ${getSummary(ev)}`}
              className={`absolute w-2 h-2 rounded-full -top-0.5 cursor-pointer hover:scale-150 transition-transform ${DOT_COLORS[cat] ?? "bg-fg-base/40"}`}
              style={{ left: `${Math.min(pct, 99)}%` }}
              onClick={() => setSelectedSeq(ev.seq)}
              onKeyDown={(e) => e.key === "Enter" && setSelectedSeq(ev.seq)}
            />
          );
        })}
      </div>

      {/* Content (hidden on session-only tab) */}
      <div className={`flex flex-1 overflow-hidden ${activeTab === "session" ? "hidden" : ""}`}>
        {/* Event list */}
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {filteredEvents.length === 0 ? (
            <p className="text-center text-fg-base/60 py-16">No events match your filter.</p>
          ) : (
            filteredEvents.map((e) => {
              const ev = e as RecordingEvent;
              const cat = getCategory(ev);
              const isSelected = ev.seq === selectedSeq;
              return (
                <div
                  key={ev.seq}
                  onClick={() => setSelectedSeq(ev.seq)}
                  className={`flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${isSelected ? "bg-inari-accent/10 border border-inari-accent/30" : "hover:bg-surface-inner"}`}
                >
                  <span className="text-xs text-fg-base/50 min-w-[50px] text-right font-mono tabular-nums pt-0.5">
                    {formatTime(ev.timestamp_ns, baseNs)}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded min-w-[60px] text-center font-medium ${BADGE_STYLES[cat] ?? "bg-surface-dim text-fg-base/60"}`}>
                    {cat}
                  </span>
                  <span className="text-sm text-fg-base flex-1 truncate">{getSummary(ev)}</span>
                  <span className="text-xs text-fg-base/50 font-mono">#{ev.seq}</span>
                </div>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        {selectedEvent && (
          <div className="w-[400px] bg-surface border-l border-line overflow-y-auto p-5 shrink-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-inari-accent">
                #{selectedEvent.seq} — {selectedEvent.kind.type}
              </h3>
              <button type="button" onClick={() => setSelectedSeq(null)} aria-label="Close detail panel" className="text-fg-base/60 hover:text-fg-strong text-lg leading-none">
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
            <pre className="bg-surface-dim border border-line rounded-lg p-4 text-xs text-fg-base overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(selectedEvent.kind, null, 2)}
            </pre>
            {selectedEvent.parent_seq != null && (
              <p className="mt-3 text-xs text-fg-base/60">
                Parent: <button onClick={() => setSelectedSeq(selectedEvent.parent_seq!)} className="text-inari-accent hover:underline">#{selectedEvent.parent_seq}</button>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
