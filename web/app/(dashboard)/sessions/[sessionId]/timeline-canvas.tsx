"use client";

import { useRef, useEffect, useCallback, useMemo } from "react";

export type TrackKind = "dom" | "network" | "console" | "io" | "error" | "nav" | "ai";

export type TrackDef = {
  id: TrackKind;
  label: string;
  color: string;
};

export type TimelineEvent = {
  timestamp: number;
  kind: TrackKind;
  summary?: string;
  /** Stable id — present for events promoted from BackendEvent / AiEvent so
   *  the canvas can match a hovered panel row to its dot on the timeline.
   *  Optional because rrweb-derived events (DOM mutations, console msgs)
   *  don't have stable ids and don't participate in causal hover. */
  id?: string;
};

export type Chapter = {
  ts: number;
  title: string;
  isError?: boolean;
};

/** Phase E — frustration markers drawn on top of the regular tracks. */
export type FrustrationMarker = {
  /** Session-relative ms. */
  ts: number;
  /** "rage" = filled red square; "dead" = hollow red square. */
  kind: "rage" | "dead";
  /** Tooltip helper. */
  selector?: string;
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

/**
 * Default track set — unchanged from the original 5-track layout so
 * existing callers that don't pass a `tracks` prop keep the same look.
 * Phase C adds `nav` to the Player's own config, not here. VAR Q1 adds
 * `ai` for FullTrace AI events (alerts, diagnoses, remediations) — also
 * opt-in per caller (player-v2 passes TRACKS_WITH_FULLTRACE).
 */
export const DEFAULT_TRACKS: TrackDef[] = [
  { id: "dom",     label: "DOM",     color: "#60a5fa" }, // blue-400
  { id: "network", label: "Network", color: "#a78bfa" }, // violet-400
  { id: "console", label: "Console", color: "#fbbf24" }, // amber-400
  { id: "io",      label: "Backend", color: "#34d399" }, // emerald-400
  { id: "error",   label: "Errors",  color: "#ef4444" }, // red-500
];

/**
 * Map causal-chain role → track id. Roles are semantic (what the event
 * represents in the incident timeline); track ids are visual channels.
 * Centralized here so a custom `tracks` prop that renames/reorders
 * channels can drive the chain-drawing code without a schema change.
 */
const ROLE_TO_TRACK_ID: Record<UiCausalLink["role"], TrackKind> = {
  user_action: "dom",
  http_cause: "network",
  db_cause: "io",
  error: "error",
};

interface TimelineCanvasProps {
  duration: number;           // total session duration in ms
  currentMs: number;          // scrubber position
  events: TimelineEvent[];
  chapters?: Chapter[];
  errorMarkers?: number[];    // timestamps (ms) of error events — highlighted
  /** Phase E — frustration markers (rage + dead clicks). Drawn on the DOM track. */
  frustrationMarkers?: FrustrationMarker[];
  /** Day 4 — comment timestamps. Rendered as small bubbles in the header
   *  band so reviewers spot them while scrubbing. */
  commentMarkers?: number[];
  causalChains?: UiCausalChain[];
  onSeek: (ms: number) => void;
  /**
   * Override the default 5-track layout. Phase C additions (e.g. "nav")
   * slot in here. Backward-compatible: omitting the prop yields the
   * original 5-track view.
   */
  tracks?: TrackDef[];
  /** VAR Q1 hover state — when a panel row is hovered, the canvas finds
   *  the matching event by id, draws a glow ring, and connects it with
   *  dashed arrows to every related event. Pass null when no hover. */
  hoveredEventId?: string | null;
  /** Ids of events causally related to `hoveredEventId`. Canvas draws
   *  a smaller glow on each + an arrow from the hovered event. */
  hoveredRelatedIds?: string[];
}

const TRACK_LABEL_WIDTH = 68;
const HEADER_HEIGHT = 24;

export function TimelineCanvas({
  duration,
  currentMs,
  events,
  chapters = [],
  errorMarkers = [],
  frustrationMarkers = [],
  commentMarkers = [],
  causalChains = [],
  onSeek,
  tracks = DEFAULT_TRACKS,
  hoveredEventId = null,
  hoveredRelatedIds = [],
}: TimelineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Lookup track index by id — replaces the old hardcoded ROLE_Y_INDEX.
  // Memoized so the causal-chain drawing loop doesn't iterate on every
  // link.
  const trackIdxById = useMemo(() => {
    const map: Partial<Record<TrackKind, number>> = {};
    tracks.forEach((t, i) => { map[t.id] = i; });
    return map;
  }, [tracks]);

  // Group events by track for faster draw. Events whose kind isn't in
  // the active `tracks` list are dropped silently (they just won't render).
  const eventsByTrack = useMemo(() => {
    const grouped: Partial<Record<TrackKind, TimelineEvent[]>> = {};
    for (const t of tracks) grouped[t.id] = [];
    for (const e of events) {
      const bucket = grouped[e.kind];
      if (bucket) bucket.push(e);
    }
    return grouped;
  }, [events, tracks]);

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
    const trackHeight = trackAreaHeight / Math.max(1, tracks.length);
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

    // Tracks — iterate over the caller-provided `tracks` array
    tracks.forEach((track, i) => {
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
      const trackEvents = eventsByTrack[track.id] ?? [];
      for (const e of trackEvents) {
        const x = eventsAreaLeft + (e.timestamp / effectiveDuration) * eventsAreaWidth;
        ctx.beginPath();
        ctx.arc(x, centerY, 2.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    });

    // Comment markers — small filled circles in the header band. Drawn
    // before the scrubber so the scrubber line stays on top when they collide.
    if (commentMarkers.length > 0) {
      ctx.fillStyle = "#f97316"; // inari-accent (orange-500) — matches the
                                  // brand pill used for comments in the panel
      for (const ts of commentMarkers) {
        const x = eventsAreaLeft + (ts / effectiveDuration) * eventsAreaWidth;
        ctx.beginPath();
        ctx.arc(x, HEADER_HEIGHT - 6, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

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

    // Frustration markers (Phase E) — squares on the DOM track. Rage =
    // filled red 8x8; dead = hollow 8x8. Drawn after dots so they overlay
    // the regular event markers on the same row.
    if (frustrationMarkers.length > 0) {
      const domIdx = trackIdxById.dom;
      if (typeof domIdx === "number") {
        const trackY = HEADER_HEIGHT + domIdx * trackHeight;
        const centerY = trackY + trackHeight / 2;
        const SIZE = 8;
        for (const m of frustrationMarkers) {
          const x = eventsAreaLeft + (m.ts / effectiveDuration) * eventsAreaWidth;
          if (m.kind === "rage") {
            ctx.fillStyle = "#ef4444"; // red-500
            ctx.fillRect(x - SIZE / 2, centerY - SIZE / 2, SIZE, SIZE);
          } else {
            ctx.strokeStyle = "#ef4444";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x - SIZE / 2, centerY - SIZE / 2, SIZE, SIZE);
          }
        }
      }
    }

    // Causal chains — dashed amber connector linking user action → HTTP → DB → error.
    // Each link's y-coordinate is derived by mapping role → track-id →
    // index in the caller's `tracks` array. This keeps chain drawing
    // correct even when the track order or content is customized.
    if (causalChains.length > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(251, 191, 36, 0.75)"; // amber-400
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);

      const yForRole = (role: UiCausalLink["role"]): number | null => {
        const trackId = ROLE_TO_TRACK_ID[role];
        const idx = trackIdxById[trackId];
        if (typeof idx !== "number") return null;
        return HEADER_HEIGHT + idx * trackHeight + trackHeight / 2;
      };

      for (const chain of causalChains) {
        if (chain.links.length < 2) continue;

        // Gather points; skip links whose role isn't in the active track set.
        const points: { x: number; y: number }[] = [];
        for (const link of chain.links) {
          const y = yForRole(link.role);
          if (y === null) continue;
          const x = eventsAreaLeft + (link.tsRelative / effectiveDuration) * eventsAreaWidth;
          points.push({ x, y });
        }
        if (points.length < 2) continue;

        ctx.beginPath();
        points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();

        // Small circle at each link end for affordance
        ctx.setLineDash([]);
        ctx.fillStyle = "#fde68a"; // amber-200
        for (const p of points) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, 2 * Math.PI);
          ctx.fill();
        }
        ctx.setLineDash([4, 3]);
      }
      ctx.restore();
    }

    // VAR Q1 — Hover causal arrows. Drawn ABOVE static causal chains and
    // BELOW the scrubber so the active hover is the most prominent layer
    // without ever obscuring the playhead.
    if (hoveredEventId) {
      const findEventById = (id: string): { x: number; y: number; track: TrackKind } | null => {
        const evt = events.find((e) => e.id === id);
        if (!evt) return null;
        const idx = trackIdxById[evt.kind];
        if (typeof idx !== "number") return null;
        const x = eventsAreaLeft + (evt.timestamp / effectiveDuration) * eventsAreaWidth;
        const y = HEADER_HEIGHT + idx * trackHeight + trackHeight / 2;
        return { x, y, track: evt.kind };
      };

      const hovered = findEventById(hoveredEventId);
      const related = hoveredRelatedIds
        .map((id) => findEventById(id))
        .filter((p): p is { x: number; y: number; track: TrackKind } => p !== null);

      if (hovered) {
        ctx.save();
        // 1) Dashed amber arrows from hovered → each related. Curved with a
        //    quadratic control point at the midpoint vertical-shifted by the
        //    track delta — keeps lines readable when both events are on
        //    different tracks (most common case for cross-track hover).
        ctx.strokeStyle = "rgba(249, 115, 22, 0.85)"; // orange-500 (inari-accent)
        ctx.lineWidth = 1.75;
        ctx.setLineDash([5, 4]);
        for (const r of related) {
          ctx.beginPath();
          ctx.moveTo(hovered.x, hovered.y);
          const midX = (hovered.x + r.x) / 2;
          // Bow the curve away from the straight line slightly so overlapping
          // arrows don't fully occlude each other.
          const midY = (hovered.y + r.y) / 2 + (r.y > hovered.y ? -8 : 8);
          ctx.quadraticCurveTo(midX, midY, r.x, r.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // 2) Filled glow on every related event (smaller).
        ctx.fillStyle = "rgba(249, 115, 22, 0.35)";
        for (const r of related) {
          ctx.beginPath();
          ctx.arc(r.x, r.y, 7, 0, 2 * Math.PI);
          ctx.fill();
        }

        // 3) Strong glow ring on the hovered event itself (the source of
        //    the hover). Layered: outer faded ring + inner solid ring.
        ctx.strokeStyle = "rgba(249, 115, 22, 0.45)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(hovered.x, hovered.y, 9, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.strokeStyle = "rgba(249, 115, 22, 1)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hovered.x, hovered.y, 5.5, 0, 2 * Math.PI);
        ctx.stroke();

        ctx.restore();
      }
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
  }, [duration, currentMs, chapters, errorMarkers, frustrationMarkers, commentMarkers, eventsByTrack, tracks, trackIdxById, causalChains, events, hoveredEventId, hoveredRelatedIds]);

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
