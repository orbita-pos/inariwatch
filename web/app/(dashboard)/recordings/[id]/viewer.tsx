"use client";

import { useState, useMemo } from "react";

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
  http: "bg-blue-900/40 text-blue-400",
  db: "bg-purple-900/40 text-purple-400",
  fs: "bg-emerald-900/40 text-emerald-400",
  time: "bg-amber-900/40 text-amber-400",
  random: "bg-amber-900/40 text-amber-400",
  dns: "bg-cyan-900/40 text-cyan-400",
  process: "bg-zinc-800 text-zinc-400",
  exception: "bg-red-900/40 text-red-400",
  marker: "bg-zinc-800 text-zinc-500",
};

const DOT_COLORS: Record<string, string> = {
  http: "bg-blue-400", db: "bg-purple-400", fs: "bg-emerald-400",
  time: "bg-amber-400", random: "bg-amber-400", dns: "bg-cyan-400",
  process: "bg-zinc-500", exception: "bg-red-400", marker: "bg-zinc-600",
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
}

export function RecordingViewer(props: ViewerProps) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);

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
        <div className="flex gap-6 mt-2 text-sm text-zinc-500 flex-wrap">
          <span><strong className="text-zinc-300">ID:</strong> {props.recordingId}</span>
          <span><strong className="text-zinc-300">Command:</strong> {props.command}</span>
          <span><strong className="text-zinc-300">Runtime:</strong> {props.runtime}</span>
          <span><strong className="text-zinc-300">Duration:</strong> {props.durationMs}ms</span>
          <span><strong className="text-zinc-300">Events:</strong> {props.eventCount}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-2 px-8 py-3 bg-surface-inner border-b border-line flex-wrap items-center">
        <input
          type="text"
          placeholder="Search events..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-surface border border-line rounded-md px-3 py-1.5 text-sm text-fg-base w-60 focus:outline-none focus:border-inari-accent"
        />
        <button
          onClick={() => setActiveCategory("all")}
          className={`text-xs px-3 py-1 rounded-md border transition-colors ${activeCategory === "all" ? "bg-inari-accent border-inari-accent text-white" : "border-line text-zinc-500 hover:text-fg-base"}`}
        >
          All
        </button>
        {allCategories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`text-xs px-3 py-1 rounded-md border transition-colors ${activeCategory === cat ? "bg-inari-accent border-inari-accent text-white" : "border-line text-zinc-500 hover:text-fg-base"}`}
          >
            {cat} ({statCounts[cat] ?? 0})
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="flex gap-3 px-8 py-3 flex-wrap">
        {Object.entries(statCounts).map(([cat, count]) => (
          <div key={cat} className="bg-surface border border-line rounded-lg px-4 py-2">
            <span className="text-xl font-bold text-fg-strong">{count}</span>
            <span className="text-xs text-zinc-500 uppercase ml-2">{cat}</span>
          </div>
        ))}
      </div>

      {/* Timeline bar */}
      <div className="relative mx-8 h-1 bg-zinc-800 rounded-full mb-4">
        {events.map((e) => {
          const ev = e as RecordingEvent;
          const cat = getCategory(ev);
          const pct = props.durationMs > 0 && ev.timestamp_ns
            ? ((ev.timestamp_ns - baseNs) / 1_000_000 / props.durationMs) * 100
            : 0;
          return (
            <div
              key={ev.seq}
              className={`absolute w-2 h-2 rounded-full -top-0.5 cursor-pointer hover:scale-150 transition-transform ${DOT_COLORS[cat] ?? "bg-zinc-500"}`}
              style={{ left: `${Math.min(pct, 99)}%` }}
              onClick={() => setSelectedSeq(ev.seq)}
              title={`#${ev.seq} ${getSummary(ev)}`}
            />
          );
        })}
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Event list */}
        <div className="flex-1 overflow-y-auto px-8 pb-8">
          {filteredEvents.length === 0 ? (
            <p className="text-center text-zinc-500 py-16">No events match your filter.</p>
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
                  <span className="text-xs text-zinc-600 min-w-[50px] text-right font-mono tabular-nums pt-0.5">
                    {formatTime(ev.timestamp_ns, baseNs)}
                  </span>
                  <span className={`text-xs px-2 py-0.5 rounded min-w-[60px] text-center font-medium ${BADGE_STYLES[cat] ?? "bg-zinc-800 text-zinc-400"}`}>
                    {cat}
                  </span>
                  <span className="text-sm text-fg-base flex-1 truncate">{getSummary(ev)}</span>
                  <span className="text-xs text-zinc-600 font-mono">#{ev.seq}</span>
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
              <button onClick={() => setSelectedSeq(null)} className="text-zinc-500 hover:text-fg-strong text-lg">
                &times;
              </button>
            </div>
            <pre className="bg-zinc-950 border border-line rounded-lg p-4 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(selectedEvent.kind, null, 2)}
            </pre>
            {selectedEvent.parent_seq != null && (
              <p className="mt-3 text-xs text-zinc-500">
                Parent: <button onClick={() => setSelectedSeq(selectedEvent.parent_seq!)} className="text-inari-accent hover:underline">#{selectedEvent.parent_seq}</button>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
