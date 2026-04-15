"use client";

import { useRef, useEffect, useCallback, useMemo } from "react";

export type TimelineEvent = {
  timestamp: number;
  kind: "dom" | "network" | "console" | "io" | "error";
  summary?: string;
};

export type Chapter = {
  ts: number;
  title: string;
  isError?: boolean;
};

/** Causal chain in UI-friendly form — timestamps relative to session start. */
export type UiCausalLink = {
  role: "user_action" | "http_cause" | "db_cause" | "error";
  tsRelative: number;
  summary: string;
};

export type UiCausalChain = {
  errorFingerprint: string;
  links: UiCausalLink[];
};

interface TimelineCanvasProps {
  duration: number;           // total session duration in ms
  currentMs: number;          // scrubber position
  events: TimelineEvent[];
  chapters?: Chapter[];
  errorMarkers?: number[];    // timestamps (ms) of error events — highlighted
  causalChains?: UiCausalChain[];
  onSeek: (ms: number) => void;
}

const ROLE_Y_INDEX: Record<UiCausalLink["role"], number> = {
  user_action: 0, // DOM track
  http_cause: 1,  // Network track
  db_cause: 3,    // Backend track (io)
  error: 4,       // Errors track
};

const TRACKS: { id: TimelineEvent["kind"]; label: string; color: string }[] = [
  { id: "dom",     label: "DOM",     color: "#60a5fa" }, // blue-400
  { id: "network", label: "Network", color: "#a78bfa" }, // violet-400
  { id: "console", label: "Console", color: "#fbbf24" }, // amber-400
  { id: "io",      label: "Backend", color: "#34d399" }, // emerald-400
  { id: "error",   label: "Errors",  color: "#ef4444" }, // red-500
];

const TRACK_LABEL_WIDTH = 68;
const HEADER_HEIGHT = 24;

export function TimelineCanvas({
  duration,
  currentMs,
  events,
  chapters = [],
  errorMarkers = [],
  causalChains = [],
  onSeek,
}: TimelineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Group events by track for faster draw
  const eventsByTrack = useMemo(() => {
    const grouped: Record<TimelineEvent["kind"], TimelineEvent[]> = {
      dom: [], network: [], console: [], io: [], error: [],
    };
    for (const e of events) {
      if (grouped[e.kind]) grouped[e.kind].push(e);
    }
    return grouped;
  }, [events]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Match canvas pixel size to device pixel ratio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = container.clientWidth;
    const cssHeight = container.clientHeight;
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Protect against division by zero — show empty timeline if duration unknown
    const effectiveDuration = duration > 0 ? duration : 1;
    const trackAreaHeight = cssHeight - HEADER_HEIGHT;
    const trackHeight = trackAreaHeight / TRACKS.length;
    const eventsAreaLeft = TRACK_LABEL_WIDTH;
    const eventsAreaWidth = cssWidth - eventsAreaLeft;

    // Header: chapter markers
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "top";
    for (const chapter of chapters) {
      const x = eventsAreaLeft + (chapter.ts / effectiveDuration) * eventsAreaWidth;
      ctx.fillStyle = chapter.isError ? "#ef4444" : "#fbbf24";
      ctx.fillRect(x, 0, 2, cssHeight);
      ctx.fillStyle = chapter.isError ? "#fca5a5" : "#fde68a";
      ctx.fillText(chapter.title.slice(0, 40), x + 4, 4);
    }

    // Tracks
    TRACKS.forEach((track, i) => {
      const y = HEADER_HEIGHT + i * trackHeight;
      const centerY = y + trackHeight / 2;

      // Track separator line
      ctx.fillStyle = "rgba(148, 163, 184, 0.12)"; // slate-400/12
      ctx.fillRect(0, y, cssWidth, 1);

      // Track label
      ctx.fillStyle = "#94a3b8"; // slate-400
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(track.label, 8, centerY);

      // Events as dots
      ctx.fillStyle = track.color;
      const trackEvents = eventsByTrack[track.id];
      for (const e of trackEvents) {
        const x = eventsAreaLeft + (e.timestamp / effectiveDuration) * eventsAreaWidth;
        ctx.beginPath();
        ctx.arc(x, centerY, 2.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    });

    // Error markers — vertical red lines across all tracks
    ctx.strokeStyle = "rgba(239, 68, 68, 0.35)";
    ctx.lineWidth = 1;
    for (const ts of errorMarkers) {
      const x = eventsAreaLeft + (ts / effectiveDuration) * eventsAreaWidth;
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT);
      ctx.lineTo(x, cssHeight);
      ctx.stroke();
    }

    // Causal chains — dashed amber connector linking user action → HTTP → DB → error
    if (causalChains.length > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(251, 191, 36, 0.75)"; // amber-400
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      for (const chain of causalChains) {
        if (chain.links.length < 2) continue;
        ctx.beginPath();
        chain.links.forEach((link, i) => {
          const x = eventsAreaLeft + (link.tsRelative / effectiveDuration) * eventsAreaWidth;
          const trackIdx = ROLE_Y_INDEX[link.role] ?? 0;
          const y = HEADER_HEIGHT + trackIdx * trackHeight + trackHeight / 2;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        // Small circle at each link end for affordance
        ctx.setLineDash([]);
        ctx.fillStyle = "#fde68a"; // amber-200
        for (const link of chain.links) {
          const x = eventsAreaLeft + (link.tsRelative / effectiveDuration) * eventsAreaWidth;
          const trackIdx = ROLE_Y_INDEX[link.role] ?? 0;
          const y = HEADER_HEIGHT + trackIdx * trackHeight + trackHeight / 2;
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.setLineDash([4, 3]);
      }
      ctx.restore();
    }

    // Scrubber — vertical white/red line
    const scrubX = eventsAreaLeft + (Math.min(currentMs, effectiveDuration) / effectiveDuration) * eventsAreaWidth;
    ctx.strokeStyle = "#f8fafc"; // slate-50
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scrubX, 0);
    ctx.lineTo(scrubX, cssHeight);
    ctx.stroke();

    // Scrubber handle (small triangle at top)
    ctx.fillStyle = "#f8fafc";
    ctx.beginPath();
    ctx.moveTo(scrubX - 5, 0);
    ctx.lineTo(scrubX + 5, 0);
    ctx.lineTo(scrubX, 6);
    ctx.closePath();
    ctx.fill();
  }, [duration, currentMs, chapters, errorMarkers, eventsByTrack]);

  // Re-draw on any prop change (draw is stable via useCallback)
  useEffect(() => {
    draw();
  }, [draw, causalChains]);

  // Re-draw on window resize
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const handlePointerEvent = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container || duration <= 0) return;
      const rect = container.getBoundingClientRect();
      const xInEvents = clientX - rect.left - TRACK_LABEL_WIDTH;
      const eventsWidth = rect.width - TRACK_LABEL_WIDTH;
      if (eventsWidth <= 0) return;
      const pct = Math.max(0, Math.min(1, xInEvents / eventsWidth));
      onSeek(pct * duration);
    },
    [duration, onSeek],
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[180px] bg-surface-inner border-t border-line cursor-pointer select-none"
      onClick={(e) => handlePointerEvent(e.clientX)}
      role="slider"
      tabIndex={0}
      aria-label="Replay timeline"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={currentMs}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSeek(Math.max(0, currentMs - 1000));
        if (e.key === "ArrowRight") onSeek(Math.min(duration, currentMs + 1000));
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
